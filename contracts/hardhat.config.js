export default {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
    },
  },
  networks: {
    elysiumTestnet: {
      type: "http",
      url: process.env.RPC_URL || "https://testnet-rpc.elysium.kinetiq.xyz",
      chainId: 99801,
      accounts: process.env.ATTESTER_PRIVATE_KEY ? [process.env.ATTESTER_PRIVATE_KEY] : [],
    },
  },
};
