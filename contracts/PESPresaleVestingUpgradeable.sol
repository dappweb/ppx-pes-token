// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract PESPresaleVestingUpgradeable is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant INITIAL_RELEASE_BPS = 2_000;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    IERC20 public pesToken;
    IERC20 public paymentToken;
    uint256 private _reentrancyStatus;

    address public fundsWallet;
    uint256 public paymentPerPackage;
    uint256 public pesPerPackage;
    uint256 public maxPackages;
    uint256 public publicPackageCap;
    uint256 public perWalletPackageLimit;
    uint64 public saleStart;
    uint64 public saleEnd;
    uint64 public launchTime;
    uint64 public vestingPeriodSeconds;
    uint16 public vestingPeriods;
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

    struct InitParams {
        IERC20 pesToken;
        IERC20 paymentToken;
        address initialOwner;
        address fundsWallet;
        uint256 paymentPerPackage;
        uint256 pesPerPackage;
        uint256 maxPackages;
        uint256 publicPackageCap;
        uint256 perWalletPackageLimit;
        uint64 saleStart;
        uint64 saleEnd;
        uint64 launchTime;
    }

    mapping(address => Allocation) public allocations;

    address public keeper;
    bool public manualClaimEnabled;
    uint64 public autoDistributionStart;
    uint64 public autoDistributionPeriodSeconds;

    event PackagesPurchased(address indexed buyer, uint256 packages, uint256 paymentAmount, uint256 tokenAmount);
    event AdminAllocationGranted(address indexed account, uint256 packages, uint256 tokenAmount);
    event Claimed(address indexed account, uint256 amount);
    event SaleWindowUpdated(uint64 saleStart, uint64 saleEnd);
    event LaunchTimeUpdated(uint64 launchTime);
    event VestingConfigUpdated(uint64 vestingPeriodSeconds, uint16 vestingPeriods);
    event ElapsedVestingPeriodsUpdated(uint16 elapsedVestingPeriods);
    event FundsWalletUpdated(address indexed fundsWallet);
    event KeeperUpdated(address indexed keeper);
    event ManualClaimEnabledUpdated(bool enabled);
    event AutoDistributionScheduleUpdated(uint64 firstReleaseTime, uint64 periodSeconds);
    event AutoDistributionBatch(
        address indexed executor,
        uint16 elapsedVestingPeriods,
        uint256 accountCount,
        uint256 distributedAmount
    );
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
    error ManualClaimDisabled();
    error NotOwnerOrKeeper();
    error AutoDistributionNotStarted();
    error InvalidAutoDistributionSchedule();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata params) public initializer {
        if (address(params.pesToken) == address(0) || address(params.paymentToken) == address(0)) {
            revert InvalidAddress();
        }

        __Ownable_init(params.initialOwner);
        __Pausable_init();

        _reentrancyStatus = NOT_ENTERED;
        pesToken = params.pesToken;
        paymentToken = params.paymentToken;
        vestingPeriodSeconds = 1 days;
        vestingPeriods = 40;

        _setFundsWallet(params.fundsWallet);
        _setPackageConfig(
            params.paymentPerPackage,
            params.pesPerPackage,
            params.maxPackages,
            params.publicPackageCap,
            params.perWalletPackageLimit
        );

        if (params.saleStart != 0 || params.saleEnd != 0) {
            _setSaleWindow(params.saleStart, params.saleEnd);
        }

        launchTime = params.launchTime;
        emit LaunchTimeUpdated(params.launchTime);
    }

    function initializeV3(
        address initialKeeper,
        bool initialManualClaimEnabled,
        uint64 firstReleaseTime,
        uint64 periodSeconds
    ) external reinitializer(3) onlyOwner {
        _setKeeper(initialKeeper);
        _setManualClaimEnabled(initialManualClaimEnabled);
        _setAutoDistributionSchedule(firstReleaseTime, periodSeconds);
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

    function setKeeper(address newKeeper) external onlyOwner {
        _setKeeper(newKeeper);
    }

    function setManualClaimEnabled(bool enabled) external onlyOwner {
        _setManualClaimEnabled(enabled);
    }

    function setAutoDistributionSchedule(uint64 firstReleaseTime, uint64 periodSeconds) external onlyOwner {
        _setAutoDistributionSchedule(firstReleaseTime, periodSeconds);
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
        if (!manualClaimEnabled) {
            revert ManualClaimDisabled();
        }

        claimedAmount = _claimFor(msg.sender, true);
    }

    function distributeVested(address[] calldata accounts)
        external
        onlyOwnerOrKeeper
        nonReentrant
        whenNotPaused
        returns (uint256 distributedAmount)
    {
        uint16 targetElapsedPeriods = currentScheduledElapsedPeriods();
        if (targetElapsedPeriods == 0) {
            revert AutoDistributionNotStarted();
        }

        if (targetElapsedPeriods > elapsedVestingPeriods) {
            _setElapsedVestingPeriods(targetElapsedPeriods);
        }

        for (uint256 i = 0; i < accounts.length; i++) {
            distributedAmount += _claimFor(accounts[i], false);
        }

        emit AutoDistributionBatch(msg.sender, elapsedVestingPeriods, accounts.length, distributedAmount);
    }

    function currentScheduledElapsedPeriods() public view returns (uint16) {
        if (
            autoDistributionStart == 0 || autoDistributionPeriodSeconds == 0
                || block.timestamp < autoDistributionStart
        ) {
            return 0;
        }

        uint256 elapsedAfterFirst = (block.timestamp - autoDistributionStart) / autoDistributionPeriodSeconds;
        uint256 targetElapsed = 1 + elapsedAfterFirst;
        uint256 maxElapsed = uint256(vestingPeriods) + 1;

        if (targetElapsed > maxElapsed) {
            targetElapsed = maxElapsed;
        }

        return uint16(targetElapsed);
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

    modifier nonReentrant() {
        require(_reentrancyStatus != ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = ENTERED;
        _;
        _reentrancyStatus = NOT_ENTERED;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) {
            revert NotOwnerOrKeeper();
        }
        _;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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

    function _setKeeper(address newKeeper) internal {
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    function _setManualClaimEnabled(bool enabled) internal {
        manualClaimEnabled = enabled;
        emit ManualClaimEnabledUpdated(enabled);
    }

    function _setAutoDistributionSchedule(uint64 firstReleaseTime, uint64 periodSeconds) internal {
        if (firstReleaseTime == 0 || periodSeconds == 0) {
            revert InvalidAutoDistributionSchedule();
        }

        autoDistributionStart = firstReleaseTime;
        autoDistributionPeriodSeconds = periodSeconds;
        emit AutoDistributionScheduleUpdated(firstReleaseTime, periodSeconds);
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

    function _claimFor(address account, bool revertIfZero) internal returns (uint256 claimedAmount) {
        claimedAmount = claimableAmount(account);
        if (claimedAmount == 0) {
            if (revertIfZero) {
                revert NoTokensClaimable();
            }
            return 0;
        }

        allocations[account].claimed += claimedAmount;
        totalTokensClaimed += claimedAmount;
        pesToken.safeTransfer(account, claimedAmount);

        emit Claimed(account, claimedAmount);
    }
}
