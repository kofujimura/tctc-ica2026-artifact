/** Minimal Hardhat 2 config: compile the fixture contracts and run a local
 *  JSON-RPC node (chainId 31337, automine). No plugins are needed because
 *  deployment is done with viem from the compiled artifacts. */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./contracts", artifacts: "./artifacts", cache: "./cache" },
  networks: {
    hardhat: { chainId: 31337, hardfork: "cancun", mining: { auto: true, interval: 1000 } },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
  },
};
