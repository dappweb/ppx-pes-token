import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { bsc } from "wagmi/chains";

const readRpcUrl = import.meta.env.VITE_READ_RPC_URL || "https://bsc-rpc.publicnode.com";
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "PES_TESTNET_PROJECT_ID";

export const wagmiConfig = getDefaultConfig({
  appName: "PES Presale",
  projectId: walletConnectProjectId,
  chains: [bsc],
  transports: {
    [bsc.id]: http(readRpcUrl),
  },
});

export { bsc };
