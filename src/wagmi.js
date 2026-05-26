import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";

const targetChain = import.meta.env.VITE_TARGET_CHAIN_ID === "97" ? bscTestnet : bsc;
const readRpcUrl =
  import.meta.env.VITE_READ_RPC_URL ||
  (targetChain.id === bscTestnet.id ? "https://bsc-testnet-rpc.publicnode.com" : "https://bsc-rpc.publicnode.com");
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "PES_TESTNET_PROJECT_ID";

export const wagmiConfig = getDefaultConfig({
  appName: "PES Presale",
  projectId: walletConnectProjectId,
  chains: [targetChain],
  transports: {
    [targetChain.id]: http(readRpcUrl),
  },
});

export { targetChain };
