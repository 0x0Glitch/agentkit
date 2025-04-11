/**
 * Vaultsfyi Action Provider
 *
 * This file contains the implementation of the VaultsfyiActionProvider,
 * which provides actions for vaultsfyi operations.
 *
 * @module vaultsfyi
 */

import { z } from "zod";
import { ActionProvider } from "../actionProvider";
import { Network } from "../../network";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  claimActionSchema,
  depositActionSchema,
  redeemActionSchema,
  VaultsActionSchema,
} from "./schemas";
import { executeActions, getVaultsLink, parseAssetAmount } from "./utils";
import { VAULTSFYI_SUPPORTED_CHAINS, VAULTS_API_URL } from "./constants";
import { fetchVaultActions } from "./api/actions";
import { fetchVaults } from "./api/vaults";
import { ApiError, Balances, Positions } from "./api/types";

/**
 * Configuration options for the OpenseaActionProvider.
 */
export interface VaultsfyiActionProviderConfig {
  /**
   * vaults.fyi API Key.
   */
  apiKey?: string;
}

/**
 * VaultsfyiActionProvider provides actions for vaultsfyi operations.
 *
 * @description
 * This provider is designed to work with EvmWalletProvider for blockchain interactions.
 * It supports all evm networks.
 */
export class VaultsfyiActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly apiKey: string;

  /**
   * Constructor for the VaultsfyiActionProvider.
   *
   * @param config - Configuration options for the provider
   */
  constructor(config: VaultsfyiActionProviderConfig = {}) {
    super("vaultsfyi", []);
    const apiKey = config.apiKey || process.env.VAULTSFYI_API_KEY;
    if (!apiKey) {
      throw new Error("VAULTSFYI_API_KEY is not configured.");
    }
    this.apiKey = apiKey;
  }

  /**
   * vaults action
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @param args - Input arguments: token, network, transactionalOnly...
   * @returns A list of vaults.
   */
  @CreateAction({
    name: "vaults",
    description: `
      This action returns a list of available vaults.
      Small vaults (under 100k TVL) are probably best avoided as they may be more risky. Unless the user is looking for high-risk, high-reward opportunities, don't include them.
      When the user asks for best vaults, optimize for apy, and if the user asks for safest/reliable vaults, optimize for TVL.
      Try to take a reasonable number of results so its easier to analyze the data.
      Format result apys as: x% (base: x%, rewards: x%) if rewards apy is available, otherwise: x%
      Examples:
      User: "Show me the best vaults"
      args: { sort: { field: 'apy', direction: 'desc' }, take: 5 }
      User: "Show me the safest vaults"
      args: { sort: { field: 'tvl', direction: 'desc' }, take: 5 }
      User: "Show me the best vaults on Arbitrum"
      args: { network: 'arbitrum', sort: { field: 'apy', direction: 'desc' }, take: 5 }
      User: "I want to earn yield on my usdc on base!"
      args: { token: 'usdc', network: 'base', sort: { field: 'apy', direction: 'desc' }, take: 5 }
      User: "What are some of the most profitable degen vaults on polygon"
      args: { network: 'polygon', sort: { field: 'apy', direction: 'desc' }, take: 5, minTvl: 0 }
      User: "Show me some more of those"
      args: { network: 'polygon', sort: { field: 'apy', direction: 'desc' }, take: 5, minTvl: 0, page: 2 }
    `,
    schema: VaultsActionSchema,
  })
  async vaults(
    wallet: EvmWalletProvider,
    args: z.infer<typeof VaultsActionSchema>,
  ): Promise<string> {
    const vaults = await fetchVaults(args, this.apiKey);
    if ("error" in vaults) {
      return `Failed to fetch vaults: ${vaults.error}, ${vaults.message}`;
    }
    if (args.protocol && !vaults.find(vault => vault.protocol === args.protocol)) {
      const supportedProtocols = vaults
        .map(vault => vault.protocol)
        .filter((value, index, self) => self.indexOf(value) === index);
      return `Protocol ${args.protocol} is not supported. Supported protocols are: ${supportedProtocols.join(", ")}`;
    }

    const transformedVaults = vaults.map(vault => ({
      name: vault.name,
      address: vault.address,
      network: vault.network,
      protocol: vault.protocol,
      tvlInUsd: Number(vault.tvlDetails.tvlUsd),
      apy: {
        base: vault.apy.base["7day"] / 100,
        rewards: vault.apy.rewards?.["7day"] ? vault.apy.rewards["7day"] / 100 : undefined,
        total: vault.apy.total["7day"] / 100,
      },
      token: {
        address: vault.token.assetAddress,
        name: vault.token.name,
        symbol: vault.token.symbol,
      },
      link: getVaultsLink(vault),
    }));

    const filteredVaults = transformedVaults.filter(vault =>
      args.protocol ? vault.protocol === args.protocol : true,
    );
    const sortedVaults = filteredVaults.sort((a, b) => {
      if (args.sort?.field === "tvl") {
        return args.sort.direction === "asc" ? a.tvlInUsd - b.tvlInUsd : b.tvlInUsd - a.tvlInUsd;
      } else if (args.sort?.field === "apy") {
        return args.sort.direction === "asc"
          ? a.apy.total - b.apy.total
          : b.apy.total - a.apy.total;
      }
      return a.name.localeCompare(b.name);
    });

    const take = args.take || 10;
    const page = args.page || 1;
    const start = (page - 1) * take;
    const end = start + take;
    const results = sortedVaults.slice(start, end);
    return JSON.stringify({
      totalResults: sortedVaults.length,
      nextPage: end < sortedVaults.length,
      results,
    });
  }

  /**
   * Deposit action
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @param args - Input arguments
   * @returns A result message
   */
  @CreateAction({
    name: "deposit",
    description: `
      This action deposits assets into a selected vault. Before depositing make sure you have the required assets in your wallet using the wallet-balances action.
      Even if you received the balance from some other source, double-check the user balance.
      Use examples:
      User: "Deposit 1000 USDC into the vault"
      actions:
       - check wallet balance for USDC
       - deposit USDC into the vault if balance is sufficient
      User: "I want more yield on my DAI"
      actions:
       - check positions that the user already has for dai
       - find high yield vaults for dai
       - if there is a vault with higher yield available, redeem from the current vault and deposit into the new vault
       - if users dai wasn't in a vault to begin with, deposit into the new vault
      User: "I want to create a diversified yield strategy"
      actions:
       - check wallet balances for all assets
       - find a couple vaults for each asset, preferably from different protocols
       - create a diversified strategy using the users assets
       - propose the strategy to the user before executing
    `,
    schema: depositActionSchema,
  })
  async deposit(
    wallet: EvmWalletProvider,
    args: z.infer<typeof depositActionSchema>,
  ): Promise<string> {
    const actions = await fetchVaultActions({
      action: "deposit",
      args: { ...args, amount: await parseAssetAmount(wallet, args.assetAddress, args.amount) },
      sender: wallet.getAddress(),
      apiKey: this.apiKey,
    });
    if ("error" in actions) {
      return `Failed to fetch deposit transactions: ${actions.error}, ${actions.message}`;
    }

    await executeActions(wallet, actions);

    return "Deposit successful";
  }

  /**
   * Redeem action
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @param args - Input arguments
   * @returns A result message
   */
  @CreateAction({
    name: "redeem",
    description: `
      This action redeems assets from a selected vault. Before redeeming make sure you have the required lp tokens in your wallet using the positions action.
      Even if you received the lp tokens from some other source, double-check the amount before redeeming.
      lp tokens aren't always 1:1 with the underlying asset, so make sure to check the amount of lp tokens you have before redeeming even if you know the amount of the underlying asset you want to redeem.
    `,
    schema: redeemActionSchema,
  })
  async redeem(
    wallet: EvmWalletProvider,
    args: z.infer<typeof redeemActionSchema>,
  ): Promise<string> {
    const actions = await fetchVaultActions({
      action: "redeem",
      args: { ...args, amount: await parseAssetAmount(wallet, args.assetAddress, args.amount) },
      sender: wallet.getAddress(),
      apiKey: this.apiKey,
    });
    if ("error" in actions) {
      return `Failed to fetch redeem transactions: ${actions.error}, ${actions.message}`;
    }

    await executeActions(wallet, actions);

    return "Redeem successful";
  }

  /**
   * Claim rewards action
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @param args - Input arguments
   * @returns A result message
   */
  @CreateAction({
    name: "claim_rewards",
    description: `
      This action claims rewards from a selected vault.
      assetAddress is the address of the vaults underlying token.
      If you're not sure what vaults have rewards claimable, use the positions action.
    `,
    schema: claimActionSchema,
  })
  async claim(wallet: EvmWalletProvider, args: z.infer<typeof claimActionSchema>): Promise<string> {
    const actions = await fetchVaultActions({
      action: "claim-rewards",
      args,
      sender: wallet.getAddress(),
      apiKey: this.apiKey,
    });
    if ("error" in actions) {
      return `Failed to fetch claim transactions: ${actions.error}, ${actions.message}`;
    }

    await executeActions(wallet, actions);

    return "Claim successful";
  }

  /**
   * Returns the users wallet token balances.
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @returns A record of the users balances
   */
  @CreateAction({
    name: "user_wallet_balances",
    description: `
    This action returns the users wallet balances of all tokens supported by vaults.fyi. Useful when you don't know token addresses but want to check if the user has an asset.
    Example queries:
    User: "What tokens do I have?"
    User: "What tokens do I have on Arbitrum?"
    User: "Whats my balance of USDC?"
    `,
    schema: z.object({}),
  })
  async balances(wallet: EvmWalletProvider): Promise<string> {
    const params = new URLSearchParams({
      account: wallet.getAddress(),
    });
    const result = await fetch(`${VAULTS_API_URL}/portfolio/wallet-balances?${params.toString()}`, {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });
    const balances = (await result.json()) as Balances | ApiError;
    if ("error" in balances) {
      return `Failed to fetch wallet balances: ${balances.error}, ${balances.message}`;
    }

    const entries = Object.entries(balances).map(
      ([network, balances]: [string, Balances[string]]) => {
        return [
          network,
          balances.map(balance => ({
            address: balance.address,
            name: balance.name,
            symbol: balance.symbol,
            balance: Number(balance.balance) / 10 ** balance.decimals,
          })),
        ];
      },
    );
    return JSON.stringify(Object.fromEntries(entries));
  }

  /**
   * Returns the users positions.
   *
   * @param wallet - The wallet provider instance for blockchain interactions
   * @returns A record of the users positions
   */
  @CreateAction({
    name: "positions",
    description: `
      This action returns the users positions in vaults.
      Example queries:
      User: "Show me my positions"
      User: "What vaults am i invested in?"
      User: "What's my average yield?"
      User: "What vaults do I have rewards in?"
    `,
    schema: z.object({}),
  })
  async positions(wallet: EvmWalletProvider): Promise<string> {
    const result = await fetch(`${VAULTS_API_URL}/portfolio/positions/${wallet.getAddress()}`, {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });
    const positions = (await result.json()) as Positions | ApiError;
    if ("error" in positions) {
      return `Failed to fetch positions: ${positions.error}, ${positions.message}`;
    }

    const entries = Object.entries(positions).map(
      ([network, positions]: [string, Positions[string]]) => {
        return [
          network,
          positions.map(position => ({
            name: position.vaultName,
            vaultAddress: position.vaultAddress,
            asset: {
              address: position.asset.assetAddress,
              name: position.asset.name,
              symbol: position.asset.symbol,
            },
            underlyingTokenBalance: Number(position.balanceNative) / 10 ** position.asset.decimals,
            lpTokenBalance: Number(position.balanceLp) / 10 ** position.asset.decimals,
            unclaimedRewards: Number(position.unclaimedUsd) > 0,
            apy: {
              base: position.apy.base / 100,
              rewards: position.apy.rewards / 100,
              total: position.apy.total / 100,
            },
          })),
        ];
      },
    );
    return JSON.stringify(Object.fromEntries(entries));
  }

  /**
   * Checks if this provider supports the given network.
   *
   * @param network - The network to check support for
   * @returns True if the network is supported
   */
  supportsNetwork(network: Network): boolean {
    return (
      network.protocolFamily == "evm" &&
      (network.chainId ? Object.keys(VAULTSFYI_SUPPORTED_CHAINS).includes(network.chainId) : false)
    );
  }
}

/**
 * Factory function to create a new VaultsfyiActionProvider instance.
 *
 * @param config - Configuration options for the provider
 * @returns A new VaultsfyiActionProvider instance
 */
export const vaultsfyiActionProvider = (config: VaultsfyiActionProviderConfig) =>
  new VaultsfyiActionProvider(config);
