import type { Network } from "@contextmem/core";

export type WalrusNetworkDefaults = {
  network: Network;
  rpcUrl: string;
  rpcUrlList: string[];
  aggregatorUrl: string;
  sitePackage: string;
  portalHost: string;
};

export const WALRUS_NETWORKS: Record<Network, WalrusNetworkDefaults> = {
  testnet: {
    network: "testnet",
    rpcUrl: "https://fullnode.testnet.sui.io",
    rpcUrlList: ["https://fullnode.testnet.sui.io"],
    aggregatorUrl: "https://aggregator.walrus-testnet.walrus.space",
    sitePackage: "0xf99aee9f21493e1590e7e5a9aea6f343a1f381031a04a732724871fc294be799",
    portalHost: "wal.app"
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: "https://fullnode.mainnet.sui.io",
    rpcUrlList: ["https://fullnode.mainnet.sui.io"],
    aggregatorUrl: "https://aggregator.walrus-mainnet.walrus.space",
    sitePackage: "0x26eb7ee8688da02c5f671679524e379f0b837a12f1d1d799f255b7eea260ad27",
    portalHost: "wal.app"
  }
};
