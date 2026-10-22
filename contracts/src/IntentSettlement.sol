// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MiniAMM} from "./MiniAMM.sol";

/// @title IntentSettlement
/// @notice Deployed once on every rollup. A user signs an EIP-712 `Intent` describing the
///         outcome they want (transfer / merchant payment / swap). The off-chain router picks
///         the best rollup, and a registered relayer submits `fill` on that rollup.
///
///         Safety properties enforced on-chain (the router is NOT trusted for these):
///         - only the user can authorise moving their funds (signature check, EIP-1271 aware);
///         - each signature is bound to one rollup (EIP-712 domain = chainId + this contract);
///         - each intent executes at most once (per-user unordered nonces, user-cancellable);
///         - intents expire (`deadline`), which is what makes safe re-routing possible;
///         - the relayer fee is capped by the user (`maxFee`);
///         - swaps are protected by `minAmountOut` (slippage bound).
contract IntentSettlement is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        TRANSFER,
        PAYMENT,
        SWAP
    }

    struct Intent {
        uint8 kind; // Kind enum
        address user; // owner of the funds and signer
        address tokenIn;
        address tokenOut; // == tokenIn for TRANSFER / PAYMENT
        uint256 amountIn;
        uint256 minAmountOut; // slippage bound for SWAP; ignored otherwise
        address recipient;
        uint256 maxFee; // relayer fee cap, in tokenIn units
        uint256 nonce;
        uint256 deadline; // unix seconds
        bytes32 ref; // merchant order id / memo for PAYMENT
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(uint8 kind,address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 maxFee,uint256 nonce,uint256 deadline,bytes32 ref)"
    );

    mapping(address => bool) public isRelayer;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    /// @dev pairKey(tokenA, tokenB) => pool
    mapping(bytes32 => address) public pools;

    error NotRelayer();
    error InvalidKind();
    error Expired(uint256 deadline, uint256 nowTs);
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error InvalidSignature();
    error InvalidIntent();
    error NoPool(address tokenIn, address tokenOut);

    event RelayerUpdated(address indexed relayer, bool allowed);
    event PoolSet(address indexed tokenA, address indexed tokenB, address pool);
    event NonceCancelled(address indexed user, uint256 nonce);
    event IntentFilled(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed relayer,
        uint8 kind,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        bytes32 ref
    );

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        _;
    }

    constructor() EIP712("CrossRollupIntentSettlement", "1") Ownable(msg.sender) {}

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        isRelayer[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setPool(address tokenA, address tokenB, address pool) external onlyOwner {
        pools[pairKey(tokenA, tokenB)] = pool;
        emit PoolSet(tokenA, tokenB, pool);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------

    /// @notice Invalidate a signed-but-unfilled intent on this rollup.
    function cancelNonce(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------------
    // Relayer
    // ---------------------------------------------------------------------

    /// @notice Execute a user-signed intent on this rollup.
    /// @param fee relayer fee actually charged (in tokenIn units), must be <= intent.maxFee.
    function fill(Intent calldata intent, bytes calldata signature, uint256 fee)
        external
        onlyRelayer
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        if (intent.kind > uint8(Kind.SWAP)) revert InvalidKind();
        if (block.timestamp > intent.deadline) revert Expired(intent.deadline, block.timestamp);
        if (fee > intent.maxFee) revert FeeTooHigh(fee, intent.maxFee);
        if (intent.amountIn == 0 || intent.recipient == address(0) || intent.user == address(0)) {
            revert InvalidIntent();
        }
        if (nonceUsed[intent.user][intent.nonce]) revert NonceAlreadyUsed(intent.user, intent.nonce);

        bytes32 digest = hashIntent(intent);
        if (!SignatureChecker.isValidSignatureNow(intent.user, digest, signature)) revert InvalidSignature();

        // Effects before interactions: burn the nonce first.
        nonceUsed[intent.user][intent.nonce] = true;

        IERC20 tokenIn = IERC20(intent.tokenIn);
        if (intent.kind == uint8(Kind.SWAP)) {
            address pool = pools[pairKey(intent.tokenIn, intent.tokenOut)];
            if (pool == address(0)) revert NoPool(intent.tokenIn, intent.tokenOut);
            tokenIn.safeTransferFrom(intent.user, address(this), intent.amountIn);
            tokenIn.forceApprove(pool, intent.amountIn);
            amountOut = MiniAMM(pool).swap(intent.tokenIn, intent.amountIn, intent.minAmountOut, intent.recipient);
        } else {
            if (intent.tokenOut != intent.tokenIn) revert InvalidIntent();
            tokenIn.safeTransferFrom(intent.user, intent.recipient, intent.amountIn);
            amountOut = intent.amountIn;
        }

        if (fee > 0) tokenIn.safeTransferFrom(intent.user, msg.sender, fee);

        emit IntentFilled(digest, intent.user, msg.sender, intent.kind, intent.amountIn, amountOut, fee, intent.ref);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice EIP-712 digest the user must sign. Exposed so the router can cross-check its encoding.
    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        // Intent has only static fields, so abi.encode(typehash, intent) is exactly the
        // EIP-712 encodeData concatenation (each field padded to 32 bytes).
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function pairKey(address a, address b) public pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
