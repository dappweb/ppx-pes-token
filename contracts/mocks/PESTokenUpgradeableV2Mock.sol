// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PESTokenUpgradeable} from "../PESTokenUpgradeable.sol";

contract PESTokenUpgradeableV2Mock is PESTokenUpgradeable {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
