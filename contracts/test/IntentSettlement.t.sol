// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IntentSettlement} from "../src/IntentSettlement.sol";
import {MiniAMM} from "../src/MiniAMM.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal smart-contract wallet (account-abstraction style): an ERC-1271 signer whose
/// signatures are produced by its owner key.
contract MockSmartWallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function approve(IERC20 token, address spender) external {
        require(msg.sender == owner, "not owner");
        token.approve(spender, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract IntentSettlementTest is Test {
    IntentSettlement settlement;
    MockERC20 usdc;
    MockERC20 weth;
    MiniAMM pool;

    uint256 alicePk = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address merchant = makeAddr("merchant");
    address relayer = makeAddr("relayer");
    address attacker = makeAddr("attacker");

    uint8 constant TRANSFER = 0;
    uint8 constant PAYMENT = 1;
    uint8 constant SWAP = 2;

    function setUp() public {
        alice = vm.addr(alicePk);
        settlement = new IntentSettlement();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        // Pool priced at 3000 USDC / WETH with 300k USDC / 100 WETH depth.
        pool = new MiniAMM(usdc, weth);
        usdc.mint(address(this), 300_000e6);
        weth.mint(address(this), 100 ether);
        usdc.approve(address(pool), type(uint256).max);
        weth.approve(address(pool), type(uint256).max);
        pool.addLiquidity(300_000e6, 100 ether);

        settlement.setRelayer(relayer, true);
        settlement.setPool(address(usdc), address(weth), address(pool));

        usdc.mint(alice, 10_000e6);
        weth.mint(alice, 5 ether);
        vm.startPrank(alice);
        usdc.approve(address(settlement), type(uint256).max);
        weth.approve(address(settlement), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _transferIntent(uint256 amount, uint256 nonce) internal view returns (IntentSettlement.Intent memory) {
        return IntentSettlement.Intent({
            kind: TRANSFER,
            user: alice,
            tokenIn: address(usdc),
            tokenOut: address(usdc),
            amountIn: amount,
            minAmountOut: amount,
            recipient: bob,
            maxFee: 1e6, // 1 USDC
            nonce: nonce,
            deadline: block.timestamp + 60,
            ref: bytes32(0)
        });
    }

    function _swapIntent(uint256 amountIn, uint256 minOut) internal view returns (IntentSettlement.Intent memory) {
        return IntentSettlement.Intent({
            kind: SWAP,
            user: alice,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: alice,
            maxFee: 1e6,
            nonce: 77,
            deadline: block.timestamp + 60,
            ref: bytes32(0)
        });
    }

    function _sign(IntentSettlement s, IntentSettlement.Intent memory intent, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, s.hashIntent(intent));
        return abi.encodePacked(r, sig, v);
    }

    function _fill(IntentSettlement.Intent memory intent, bytes memory sig, uint256 fee) internal returns (uint256) {
        vm.prank(relayer);
        return settlement.fill(intent, sig, fee);
    }

    // ------------------------------------------------------------------ happy paths

    function test_TransferMovesFundsAndPaysRelayer() public {
        IntentSettlement.Intent memory intent = _transferIntent(100e6, 1);
        bytes memory sig = _sign(settlement, intent, alicePk);

        uint256 out = _fill(intent, sig, 0.02e6);

        assertEq(out, 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(relayer), 0.02e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 100e6 - 0.02e6);
        assertTrue(settlement.nonceUsed(alice, 1));
    }

    function test_PaymentEmitsMerchantReference() public {
        IntentSettlement.Intent memory intent = _transferIntent(25e6, 2);
        intent.kind = PAYMENT;
        intent.recipient = merchant;
        intent.ref = keccak256("ORDER-1001");
        bytes memory sig = _sign(settlement, intent, alicePk);

        vm.expectEmit(true, true, true, true);
        emit IntentSettlement.IntentFilled(
            settlement.hashIntent(intent), alice, relayer, PAYMENT, 25e6, 25e6, 0, keccak256("ORDER-1001")
        );
        _fill(intent, sig, 0);
        assertEq(usdc.balanceOf(merchant), 25e6);
    }

    function test_SwapRoutesThroughPoolAndRespectsQuote() public {
        uint256 quote = pool.getAmountOut(address(usdc), 3000e6);
        IntentSettlement.Intent memory intent = _swapIntent(3000e6, quote);
        bytes memory sig = _sign(settlement, intent, alicePk);

        uint256 out = _fill(intent, sig, 0.5e6);

        assertEq(out, quote);
        assertEq(weth.balanceOf(alice), 5 ether + quote);
        assertEq(usdc.balanceOf(address(settlement)), 0, "settlement must not keep funds");
        assertEq(usdc.allowance(address(settlement), address(pool)), 0, "no dangling allowance");
        // ~0.99 WETH after 0.3% fee and price impact
        assertApproxEqRel(out, 0.987 ether, 0.01e18);
    }

    // ------------------------------------------------------------------ security / edge cases

    function test_RevertWhen_ReplayingSameIntent() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 3);
        bytes memory sig = _sign(settlement, intent, alicePk);
        _fill(intent, sig, 0);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.NonceAlreadyUsed.selector, alice, 3));
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_SignedByWrongKey() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 4);
        bytes memory sig = _sign(settlement, intent, 0xBAD);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidSignature.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_RelayerTampersWithIntent() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 5);
        bytes memory sig = _sign(settlement, intent, alicePk);
        intent.recipient = attacker; // redirect funds
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidSignature.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_CallerIsNotRelayer() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 6);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(attacker);
        vm.expectRevert(IntentSettlement.NotRelayer.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_FeeAboveUserCap() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 7);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.FeeTooHigh.selector, 2e6, 1e6));
        settlement.fill(intent, sig, 2e6);
    }

    function test_RevertWhen_Expired() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 8);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.warp(intent.deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.Expired.selector, intent.deadline, intent.deadline + 1));
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_UserCancelledNonce() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 9);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(alice);
        settlement.cancelNonce(9);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.NonceAlreadyUsed.selector, alice, 9));
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_InsufficientBalance() public {
        IntentSettlement.Intent memory intent = _transferIntent(20_000e6, 10); // alice has 10k
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(); // ERC20InsufficientBalance
        settlement.fill(intent, sig, 0);
        assertFalse(settlement.nonceUsed(alice, 10), "failed fill must roll back the nonce");
    }

    function test_RevertWhen_SwapSlippageExceeded() public {
        uint256 quote = pool.getAmountOut(address(usdc), 3000e6);
        IntentSettlement.Intent memory intent = _swapIntent(3000e6, quote + 1);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MiniAMM.SlippageExceeded.selector, quote, quote + 1));
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_SwapTooLargeForPoolDepth() public {
        // 1M USDC into a 300k USDC pool: price impact makes output far below the 3000-price expectation.
        usdc.mint(alice, 1_000_000e6);
        IntentSettlement.Intent memory intent = _swapIntent(1_000_000e6, 300 ether);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(); // SlippageExceeded — pool can give at most ~77 WETH
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_NoPoolForPair() public {
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        IntentSettlement.Intent memory intent = _swapIntent(100e6, 1);
        intent.tokenOut = address(dai);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.NoPool.selector, address(usdc), address(dai)));
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_TransferWithMismatchedTokens() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 11);
        intent.tokenOut = address(weth);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidIntent.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_RevertWhen_InvalidKind() public {
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 12);
        intent.kind = 3;
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidKind.selector);
        settlement.fill(intent, sig, 0);
    }

    /// A signature for rollup A must not be replayable on rollup B (cross-rollup double spend).
    function test_SignatureIsBoundToOneRollup() public {
        IntentSettlement other = new IntentSettlement(); // same chain, different verifying contract
        other.setRelayer(relayer, true);
        vm.prank(alice);
        usdc.approve(address(other), type(uint256).max);

        IntentSettlement.Intent memory intent = _transferIntent(10e6, 13);
        bytes memory sig = _sign(settlement, intent, alicePk);

        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidSignature.selector);
        other.fill(intent, sig, 0);

        // Different chainId, same contract address: also rejected.
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidSignature.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_OnlyOwnerAdmin() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        settlement.setRelayer(attacker, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        settlement.setPool(address(usdc), address(weth), attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        settlement.pause();
        vm.stopPrank();
    }

    function test_PauseBlocksFills() public {
        settlement.pause();
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 14);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.fill(intent, sig, 0);
    }

    function test_RemovedRelayerCannotFill() public {
        settlement.setRelayer(relayer, false);
        IntentSettlement.Intent memory intent = _transferIntent(10e6, 15);
        bytes memory sig = _sign(settlement, intent, alicePk);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.NotRelayer.selector);
        settlement.fill(intent, sig, 0);
    }

    // ------------------------------------------------------------------ account abstraction

    /// Smart-contract wallets (ERC-1271) can own funds and sign intents, e.g. ERC-4337 accounts.
    function test_SmartWalletCanSignIntent() public {
        MockSmartWallet wallet = new MockSmartWallet(alice);
        usdc.mint(address(wallet), 50e6);
        vm.prank(alice);
        wallet.approve(usdc, address(settlement));

        IntentSettlement.Intent memory intent = _transferIntent(20e6, 99);
        intent.user = address(wallet);
        bytes memory sig = _sign(settlement, intent, alicePk); // owner key signs for the wallet
        _fill(intent, sig, 0.01e6);
        assertEq(usdc.balanceOf(bob), 20e6);
        assertEq(usdc.balanceOf(address(wallet)), 50e6 - 20e6 - 0.01e6);

        // A signature from someone other than the wallet owner is rejected.
        IntentSettlement.Intent memory intent2 = _transferIntent(1e6, 100);
        intent2.user = address(wallet);
        bytes memory badSig = _sign(settlement, intent2, 0xBAD);
        vm.prank(relayer);
        vm.expectRevert(IntentSettlement.InvalidSignature.selector);
        settlement.fill(intent2, badSig, 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Value conservation: alice loses exactly amount + fee, bob/relayer gain exactly that.
    function testFuzz_TransferConservesValue(uint256 amount, uint256 fee, uint256 nonce) public {
        amount = bound(amount, 1, 9_000e6);
        fee = bound(fee, 0, 1e6);
        IntentSettlement.Intent memory intent = _transferIntent(amount, nonce);
        bytes memory sig = _sign(settlement, intent, alicePk);

        uint256 total = usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(relayer);
        _fill(intent, sig, fee);

        assertEq(usdc.balanceOf(bob), amount);
        assertEq(usdc.balanceOf(relayer), fee);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(relayer), total);
    }

    /// The pool invariant k = x*y never decreases after a swap.
    function testFuzz_SwapNeverDecreasesK(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 9_000e6);
        uint256 kBefore = pool.reserve0() * pool.reserve1();
        IntentSettlement.Intent memory intent = _swapIntent(amountIn, 0);
        bytes memory sig = _sign(settlement, intent, alicePk);
        _fill(intent, sig, 0);
        assertGe(pool.reserve0() * pool.reserve1(), kBefore);
    }
}
