const hre = require("hardhat");

const PRESALE_PROXY = "0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd";

async function main() {
  const Presale = await hre.ethers.getContractFactory("PESPresaleVestingUpgradeable");
  const imported = await hre.upgrades.forceImport(PRESALE_PROXY, Presale, { kind: "uups" });
  const address = await imported.getAddress();
  const implementation = await hre.upgrades.erc1967.getImplementationAddress(PRESALE_PROXY);

  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        proxy: address,
        implementation,
        manifest: "refreshed",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
