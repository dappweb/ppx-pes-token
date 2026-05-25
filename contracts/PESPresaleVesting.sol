// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PESPresaleVesting is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant INITIAL_RELEASE_BPS = 2_000;

    IERC20 public immutable pesToken;
    IERC20 public immutable paymentToken;

    address public fundsWallet;
    uint256 public paymentPerPackage;
    uint256 public pesPerPackage;
    uint256 public maxPackages;
    uint256 public publicPackageCap;
    uint256 public perWalletPackageLimit;
    uint64 public saleStart;
    uint64 public saleEnd;
    uint64 public launchTime;
    uint64 public vestingPeriodSeconds = 1 days;
    uint16 public vestingPeriods = 40;
    uint16 public elapsedVestingPeriods;

    uint256 public publicPackagesSold;
    uint256 public totalPackagesAllocated;
    uint256 public totalTokensAllocated;
    uint256 public totalTokensClaimed;

    struct Allocation {
        uint256 packages;
        uint256 tokens;
        uint256 claimed;
    }

    mapping(address => Allocation) public allocations;

    event PackagesPurchased(address indexed buyer, uint256 packages, uint256 paymentAmount, uint256 tokenAmount);
    event AdminAllocationGranted(address indexed account, uint256 packages, uint256 tokenAmount);
    event Claimed(address indexed account, uint256 amount);
    event SaleWindowUpdated(uint64 saleStart, uint64 saleEnd);
    event LaunchTimeUpdated(uint64 launchTime);
    event VestingConfigUpdated(uint64 vestingPeriodSeconds, uint16 vestingPeriods);
    event ElapsedVestingPeriodsUpdated(uint16 elapsedVestingPeriods);
    event FundsWalletUpdated(address indexed fundsWallet);
    event PackageConfigUpdated(
        uint256 paymentPerPackage,
        uint256 pesPerPackage,
        uint256 maxPackages,
        uint256 publicPackageCap,
        uint256 perWalletPackageLimit
    );

    error InvalidAddress();
    error InvalidAmount();
    error InvalidSaleWindow();
    error SaleNotActive();
    error PublicPackageCapExceeded();
    error MaxPackageCapExceeded();
    error PerWalletLimitExceeded();
    error LaunchAlreadyStarted();
    error NoTokensClaimable();
    error ReservedTokenRecovery();
    error VestingProgressDecrease();
    error VestingProgressTooHigh();

    constructor(
        IERC20 pesToken_,
        IERC20 paymentToken_,
        address initialOwner,
        address fundsWallet_,
        uint256 paymentPerPackage_,
        uint256 pesPerPackage_,
        uint256 maxPackages_,
        uint256 publicPackageCap_,
        uint256 perWalletPackageLimit_,
        uint64 saleStart_,
        uint64 saleEnd_,
        uint64 launchTime_
    ) Ownable(initialOwner) {
        if (address(pesToken_) == address(0) || address(paymentToken_) == address(0)) {
            revert InvalidAddress();
        }

        pesToken = pesToken_;
        paymentToken = paymentToken_;
        _setFundsWallet(fundsWallet_);
        _setPackageConfig(
            paymentPerPackage_, pesPerPackage_, maxPackages_, publicPackageCap_, perWalletPackageLimit_
        );

        if (saleStart_ != 0 || saleEnd_ != 0) {
            _setSaleWindow(saleStart_, saleEnd_);
        }

        launchTime = launchTime_;
        emit LaunchTimeUpdated(launchTime_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setSaleWindow(uint64 newSaleStart, uint64 newSaleEnd) external onlyOwner {
        _setSaleWindow(newSaleStart, newSaleEnd);
    }

    function setLaunchTime(uint64 newLaunchTime) external onlyOwner {
        if (launchTime != 0 && block.timestamp >= launchTime) {
            revert LaunchAlreadyStarted();
        }

        launchTime = newLaunchTime;
        emit LaunchTimeUpdated(newLaunchTime);
    }

    function setVestingConfig(uint64 newVestingPeriodSeconds, uint16 newVestingPeriods) external onlyOwner {
        _setVestingConfig(newVestingPeriodSeconds, newVestingPeriods);
    }

    function setElapsedVestingPeriods(uint16 newElapsedVestingPeriods) external onlyOwner {
        _setElapsedVestingPeriods(newElapsedVestingPeriods);
    }

    function setVestingConfigAndProgress(
        uint64 newVestingPeriodSeconds,
        uint16 newVestingPeriods,
        uint16 newElapsedVestingPeriods
    ) external onlyOwner {
        _setVestingConfig(newVestingPeriodSeconds, newVestingPeriods);
        _setElapsedVestingPeriods(newElapsedVestingPeriods);
    }

    function setFundsWallet(address newFundsWallet) external onlyOwner {
        _setFundsWallet(newFundsWallet);
    }

    function setPackageConfig(
        uint256 newPaymentPerPackage,
        uint256 newPesPerPackage,
        uint256 newMaxPackages,
        uint256 newPublicPackageCap,
        uint256 newPerWalletPackageLimit
    ) external onlyOwner {
        if (totalPackagesAllocated > newMaxPackages || publicPackagesSold > newPublicPackageCap) {
            revert InvalidAmount();
        }

        _setPackageConfig(
            newPaymentPerPackage,
            newPesPerPackage,
            newMaxPackages,
            newPublicPackageCap,
            newPerWalletPackageLimit
        );
    }

    function purchasePackages(uint256 packages) external nonReentrant whenNotPaused {
        if (packages == 0) {
            revert InvalidAmount();
        }

        if (saleStart == 0 || block.timestamp < saleStart || block.timestamp > saleEnd) {
            revert SaleNotActive();
        }

        if (publicPackagesSold + packages > publicPackageCap) {
            revert PublicPackageCapExceeded();
        }

        Allocation storage allocation = allocations[msg.sender];
        if (allocation.packages + packages > perWalletPackageLimit) {
            revert PerWalletLimitExceeded();
        }

        uint256 paymentAmount = paymentPerPackage * packages;
        uint256 tokenAmount = _addAllocation(msg.sender, packages);

        publicPackagesSold += packages;
        paymentToken.safeTransferFrom(msg.sender, fundsWallet, paymentAmount);

        emit PackagesPurchased(msg.sender, packages, paymentAmount, tokenAmount);
    }

    function grantAllocation(address account, uint256 packages) external onlyOwner {
        uint256 tokenAmount = _addAllocation(account, packages);
        emit AdminAllocationGranted(account, packages, tokenAmount);
    }

    function grantAllocations(address[] calldata accounts, uint256[] calldata packagesList) external onlyOwner {
        if (accounts.length != packagesList.length) {
            revert InvalidAmount();
        }

        for (uint256 i = 0; i < accounts.length; i++) {
            uint256 tokenAmount = _addAllocation(accounts[i], packagesList[i]);
            emit AdminAllocationGranted(accounts[i], packagesList[i], tokenAmount);
        }
    }

    function claim() external nonReentrant whenNotPaused returns (uint256 claimedAmount) {
        claimedAmount = claimableAmount(msg.sender);
        if (claimedAmount == 0) {
            revert NoTokensClaimable();
        }

        allocations[msg.sender].claimed += claimedAmount;
        totalTokensClaimed += claimedAmount;
        pesToken.safeTransfer(msg.sender, claimedAmount);

        emit Claimed(msg.sender, claimedAmount);
    }

    function vestedAmount(address account) public view returns (uint256) {
        Allocation memory allocation = allocations[account];
        if (allocation.tokens == 0) {
            return 0;
        }

        uint256 elapsedPeriods = elapsedVestingPeriods;
        if (elapsedPeriods == 0) {
            return 0;
        }

        if (elapsedPeriods > vestingPeriods) {
            return allocation.tokens;
        }

        uint256 remainingBps = BPS_DENOMINATOR - INITIAL_RELEASE_BPS;
        uint256 releaseBps = INITIAL_RELEASE_BPS + ((remainingBps * (elapsedPeriods - 1)) / vestingPeriods);
        return (allocation.tokens * releaseBps) / BPS_DENOMINATOR;
    }

    function claimableAmount(address account) public view returns (uint256) {
        uint256 vested = vestedAmount(account);
        uint256 claimed = allocations[account].claimed;
        if (vested <= claimed) {
            return 0;
        }

        return vested - claimed;
    }

    function unclaimedAllocatedTokens() public view returns (uint256) {
        return totalTokensAllocated - totalTokensClaimed;
    }

    function recoverUnsupportedToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || address(token) == address(0)) {
            revert InvalidAddress();
        }

        if (address(token) == address(pesToken)) {
            uint256 balance = pesToken.balanceOf(address(this));
            uint256 reserved = unclaimedAllocatedTokens();
            if (balance < reserved || amount > balance - reserved) {
                revert ReservedTokenRecovery();
            }
        }

        token.safeTransfer(to, amount);
    }

    function _setSaleWindow(uint64 newSaleStart, uint64 newSaleEnd) internal {
        if (newSaleStart == 0 || newSaleEnd <= newSaleStart) {
            revert InvalidSaleWindow();
        }

        saleStart = newSaleStart;
        saleEnd = newSaleEnd;
        emit SaleWindowUpdated(newSaleStart, newSaleEnd);
    }

    function _setFundsWallet(address newFundsWallet) internal {
        if (newFundsWallet == address(0)) {
            revert InvalidAddress();
        }

        fundsWallet = newFundsWallet;
        emit FundsWalletUpdated(newFundsWallet);
    }

    function _setVestingConfig(uint64 newVestingPeriodSeconds, uint16 newVestingPeriods) internal {
        if (newVestingPeriodSeconds == 0 || newVestingPeriods == 0) {
            revert InvalidAmount();
        }

        if (elapsedVestingPeriods > uint256(newVestingPeriods) + 1) {
            revert VestingProgressTooHigh();
        }

        vestingPeriodSeconds = newVestingPeriodSeconds;
        vestingPeriods = newVestingPeriods;
        emit VestingConfigUpdated(newVestingPeriodSeconds, newVestingPeriods);
    }

    function _setElapsedVestingPeriods(uint16 newElapsedVestingPeriods) internal {
        if (newElapsedVestingPeriods < elapsedVestingPeriods) {
            revert VestingProgressDecrease();
        }

        if (newElapsedVestingPeriods > uint256(vestingPeriods) + 1) {
            revert VestingProgressTooHigh();
        }

        elapsedVestingPeriods = newElapsedVestingPeriods;
        emit ElapsedVestingPeriodsUpdated(newElapsedVestingPeriods);
    }

    function _setPackageConfig(
        uint256 newPaymentPerPackage,
        uint256 newPesPerPackage,
        uint256 newMaxPackages,
        uint256 newPublicPackageCap,
        uint256 newPerWalletPackageLimit
    ) internal {
        if (
            newPaymentPerPackage == 0 || newPesPerPackage == 0 || newMaxPackages == 0
                || newPublicPackageCap > newMaxPackages || newPerWalletPackageLimit == 0
        ) {
            revert InvalidAmount();
        }

        paymentPerPackage = newPaymentPerPackage;
        pesPerPackage = newPesPerPackage;
        maxPackages = newMaxPackages;
        publicPackageCap = newPublicPackageCap;
        perWalletPackageLimit = newPerWalletPackageLimit;

        emit PackageConfigUpdated(
            newPaymentPerPackage,
            newPesPerPackage,
            newMaxPackages,
            newPublicPackageCap,
            newPerWalletPackageLimit
        );
    }

    function _addAllocation(address account, uint256 packages) internal returns (uint256 tokenAmount) {
        if (account == address(0)) {
            revert InvalidAddress();
        }

        if (packages == 0) {
            revert InvalidAmount();
        }

        if (totalPackagesAllocated + packages > maxPackages) {
            revert MaxPackageCapExceeded();
        }

        tokenAmount = pesPerPackage * packages;
        Allocation storage allocation = allocations[account];
        allocation.packages += packages;
        allocation.tokens += tokenAmount;
        totalPackagesAllocated += packages;
        totalTokensAllocated += tokenAmount;
    }
}

