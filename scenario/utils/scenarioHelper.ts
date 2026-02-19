import { ScenarioConfig } from './config/types';
import { commonConfig } from './config/common';
import { transferConfig } from './config/transfer';
import { withdrawConfig } from './config/withdraw';
import { supplyConfig } from './config/supply';
import { bulkerConfig } from './config/bulker';
import { liquidationConfig } from './config/liquidation';
import { rewardsConfig } from './config/rewards';
import { authorizationConfig } from './config/authorization';
import { governanceConfig } from './config/governance';
import { interestRateConfig } from './config/interestRate';
import { configuratorConfig } from './config/configurator';
import { liquidationBotConfig } from './config/liquidationBot';
import { mainnetBulkerConfig } from './config/mainnetBulker';
import { v2Config } from './config/v2';
import { assetsConfig } from './config/assets';
import { applyNetworkOverrides } from './config/networks';
import { CometContext } from '../context/CometContext';
import cloneDeep from 'lodash/cloneDeep';

function createDefaultConfig(): ScenarioConfig {
  return {
    common: commonConfig,
    transfer: transferConfig,
    withdraw: withdrawConfig,
    supply: supplyConfig,
    bulker: bulkerConfig,
    liquidation: liquidationConfig,
    rewards: rewardsConfig,
    authorization: authorizationConfig,
    governance: governanceConfig,
    interestRate: interestRateConfig,
    configurator: configuratorConfig,
    liquidationBot: liquidationBotConfig,
    mainnetBulker: mainnetBulkerConfig,
    compoundV2: v2Config,
    assets: assetsConfig
  };
}

export function getConfigForScenario(ctx: CometContext, i?: number) {
  const config = cloneDeep(createDefaultConfig());
  const structured = applyNetworkOverrides(config, ctx);

  const network = ctx?.world?.base?.network;
  const deployment = ctx?.world?.base?.deployment;

  // Flat property aliases derived from structured config (for AUDIT-added scenarios)
  let supplyCollateral = Number(structured.supply.collateralAmount);
  let transferCollateral = Number(structured.transfer.collateralAmount);
  let transferBase = Number(structured.transfer.baseAmount);
  let transferAsset = Number(structured.transfer.assetAmount);
  let withdrawCollateral = Number(structured.withdraw.collateralAmount);
  let withdrawBase = Number(structured.withdraw.baseAmount);
  let supplyBase = 1000;
  const reservesBase = 5000;

  // Network-level flat overrides not fully covered by structured config
  if (network === 'unichain' && deployment === 'weth') {
    supplyCollateral = 10;
    transferCollateral = 10;
    withdrawCollateral = 10;
  }
  if (network === 'ronin' && deployment === 'weth') {
    supplyBase = 100;
  }

  // i-specific overrides for small-value collaterals (e.g. tBTC)
  if (i !== undefined) {
    if (network === 'base' && deployment === 'usdc' && i === 4) {
      supplyCollateral = 2; transferCollateral = 2; withdrawCollateral = 2;
    }
    if (network === 'arbitrum' && deployment === 'usdc' && i === 8) {
      supplyCollateral = 2; transferCollateral = 2; withdrawCollateral = 2;
    }
    if (network === 'arbitrum' && deployment === 'usdt' && i === 5) {
      supplyCollateral = 2; transferCollateral = 2; withdrawCollateral = 2;
    }
  }

  return {
    ...structured,
    supplyCollateral,
    transferCollateral,
    transferBase,
    transferAsset,
    withdrawCollateral,
    withdrawBase,
    supplyBase,
    reservesBase,
  };
}

export * from './config/types';
