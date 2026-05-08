// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PESToken is ERC20, Ownable, Pausable {
    uint256 public constant TOTAL_SUPPLY = 21_000_000 * 1e18;
    uint16 public constant FEE_DENOMINATOR = 10_000;
    uint16 public constant MAX_TOTAL_FEE_BPS = 1_000;

    struct FeeRates {
        uint16 liquidityBps;
        uint16 operationsBps;
        uint16 burnBps;
    }

    FeeRates public buyFees;
    FeeRates public sellFees;

    address public liquidityWallet;
    address public operationsWallet;
    bool public tradingEnabled;

    mapping(address => bool) public automatedMarketMakerPairs;
    mapping(address => bool) public isExcludedFromFees;

    event AutomatedMarketMakerPairUpdated(address indexed pair, bool indexed enabled);
    event ExcludedFromFees(address indexed account, bool indexed excluded);
    event FeeRatesUpdated(bool indexed isBuyFee, uint16 liquidityBps, uint16 operationsBps, uint16 burnBps);
    event FeeWalletsUpdated(address indexed liquidityWallet, address indexed operationsWallet);
    event TradingEnabledUpdated(bool enabled);

    error InvalidAddress();
    error FeeTooHigh();
    error TradingNotEnabled();

    constructor(address initialOwner, address initialLiquidityWallet, address initialOperationsWallet)
        ERC20("PES Token", "PES")
        Ownable(initialOwner)
    {
        if (
            initialOwner == address(0) || initialLiquidityWallet == address(0)
                || initialOperationsWallet == address(0)
        ) {
            revert InvalidAddress();
        }

        liquidityWallet = initialLiquidityWallet;
        operationsWallet = initialOperationsWallet;

        buyFees = FeeRates({liquidityBps: 50, operationsBps: 50, burnBps: 50});
        sellFees = FeeRates({liquidityBps: 50, operationsBps: 50, burnBps: 50});

        isExcludedFromFees[initialOwner] = true;
        isExcludedFromFees[address(this)] = true;
        isExcludedFromFees[initialLiquidityWallet] = true;
        isExcludedFromFees[initialOperationsWallet] = true;

        emit ExcludedFromFees(initialOwner, true);
        emit ExcludedFromFees(address(this), true);
        emit ExcludedFromFees(initialLiquidityWallet, true);
        emit ExcludedFromFees(initialOperationsWallet, true);

        _mint(initialOwner, TOTAL_SUPPLY);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setTradingEnabled(bool enabled) external onlyOwner {
        tradingEnabled = enabled;
        emit TradingEnabledUpdated(enabled);
    }

    function setAutomatedMarketMakerPair(address pair, bool enabled) external onlyOwner {
        if (pair == address(0)) {
            revert InvalidAddress();
        }

        automatedMarketMakerPairs[pair] = enabled;
        emit AutomatedMarketMakerPairUpdated(pair, enabled);
    }

    function setExcludedFromFees(address account, bool excluded) external onlyOwner {
        if (account == address(0)) {
            revert InvalidAddress();
        }

        isExcludedFromFees[account] = excluded;
        emit ExcludedFromFees(account, excluded);
    }

    function setFeeWallets(address newLiquidityWallet, address newOperationsWallet) external onlyOwner {
        if (newLiquidityWallet == address(0) || newOperationsWallet == address(0)) {
            revert InvalidAddress();
        }

        liquidityWallet = newLiquidityWallet;
        operationsWallet = newOperationsWallet;
        emit FeeWalletsUpdated(newLiquidityWallet, newOperationsWallet);
    }

    function setFeeRates(bool isBuyFee, uint16 liquidityBps, uint16 operationsBps, uint16 burnBps)
        external
        onlyOwner
    {
        uint16 totalFeeBps = liquidityBps + operationsBps + burnBps;
        if (totalFeeBps > MAX_TOTAL_FEE_BPS) {
            revert FeeTooHigh();
        }

        FeeRates memory newFees =
            FeeRates({liquidityBps: liquidityBps, operationsBps: operationsBps, burnBps: burnBps});

        if (isBuyFee) {
            buyFees = newFees;
        } else {
            sellFees = newFees;
        }

        emit FeeRatesUpdated(isBuyFee, liquidityBps, operationsBps, burnBps);
    }

    function totalBuyFeeBps() external view returns (uint16) {
        return buyFees.liquidityBps + buyFees.operationsBps + buyFees.burnBps;
    }

    function totalSellFeeBps() external view returns (uint16) {
        return sellFees.liquidityBps + sellFees.operationsBps + sellFees.burnBps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        require(!paused(), "PESToken: paused");

        bool isBuy = automatedMarketMakerPairs[from];
        bool isSell = automatedMarketMakerPairs[to];
        bool feeExempt = isExcludedFromFees[from] || isExcludedFromFees[to];

        if ((isBuy || isSell) && !tradingEnabled && !feeExempt) {
            revert TradingNotEnabled();
        }

        if ((!isBuy && !isSell) || feeExempt) {
            super._update(from, to, value);
            return;
        }

        FeeRates memory fees = isBuy ? buyFees : sellFees;
        uint256 liquidityFee = (value * fees.liquidityBps) / FEE_DENOMINATOR;
        uint256 operationsFee = (value * fees.operationsBps) / FEE_DENOMINATOR;
        uint256 burnFee = (value * fees.burnBps) / FEE_DENOMINATOR;
        uint256 totalFee = liquidityFee + operationsFee + burnFee;

        if (totalFee == 0) {
            super._update(from, to, value);
            return;
        }

        if (liquidityFee > 0) {
            super._update(from, liquidityWallet, liquidityFee);
        }

        if (operationsFee > 0) {
            super._update(from, operationsWallet, operationsFee);
        }

        if (burnFee > 0) {
            super._update(from, address(0), burnFee);
        }

        super._update(from, to, value - totalFee);
    }
}

