import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, expectRevertMatches, getExpectedBaseBalance, getInterest, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS, UINT256_MAX, fundAccount, usesAssetList, isAssetDelisted, supportsExtendedPause } from './utils';
import { ContractReceipt } from 'ethers';
import { matchesDeployment } from './utils';
import { ethers } from 'hardhat';
import { getConfigForScenario } from './utils/scenarioHelper';
import { exp } from '../test/helpers';
import { log } from 'console';

async function testSupplyCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(config.supply.collateralAmount) * scale;
  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);
  await collateralAsset.approve(albert, comet.address);
  const totalCollateralSupply = (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
  if (totalCollateralSupply + toSupply > supplyCap.toBigInt()) {
    await expectRevertCustom(
      albert.supplyAsset({
        asset: collateralAsset.address,
        amount: BigInt(config.supply.collateralAmount) * scale,
      }),
      'SupplyCapExceeded()'
    );
  } else {
    const txn = await albert.supplyAsset({ asset: collateralAsset.address, amount: toSupply });
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupply);
    return txn;
  }
}

async function testSupplyFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(config.supply.collateralAmount) * scale;
  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(0n);
  await collateralAsset.approve(albert, comet.address);
  await albert.allow(betty, true);
  const totalCollateralSupply = (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
  if (totalCollateralSupply + toSupply > supplyCap.toBigInt()) {
    await expectRevertCustom(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: toSupply,
      }),
      'SupplyCapExceeded()'
    );
  } else {
    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toSupply });
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(toSupply);
    return txn;
  }
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#supply > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).supply.collateralAmount)),
      tokenBalances: async (ctx) => (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supply.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testSupplyCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#supplyFrom > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).supply.collateralAmount)),
      tokenBalances: async (ctx) => (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supply.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testSupplyFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#supply > base asset',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supply.baseSupplyAmount * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supply.baseSupplyAmount * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(config.supply.baseSupplyAmount * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supply > base asset with token fees',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyWithFees },
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(String(config.supply.ethBalanceForGas)).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(config.supply.usdtFeeBasisPoints, config.supply.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supply.baseSupplyWithFees * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supply.baseSupplyWithFees * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(config.supply.baseSupplyAfterFees * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supply > repay borrow',
  {
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: `== ${getConfigForScenario(ctx).liquidation.base.borrowPrincipal}`
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.liquidation.base.borrowPrincipal) * scale, getInterest(BigInt(config.liquidation.base.borrowPrincipal) * scale, borrowRate, config.supply.interestTimeFactor.short) + config.common.tolerances.interest.small);
    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BigInt(config.liquidation.base.borrowPrincipal) * scale });
    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(BigInt(config.liquidation.base.borrowPrincipal) * scale, borrowRate, config.supply.interestTimeFactor.long) + config.common.tolerances.interest.medium);
    return txn;
  }
);

scenario(
  'Comet#supply > repay borrow with token fees',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: `==${getConfigForScenario(ctx).supply.baseSupplyWithFees}` }
    }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).supply.baseSupplyWithFees }
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(String(config.supply.ethBalanceForGas)).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(config.supply.usdtFeeBasisPoints, config.supply.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), config.supply.baseBorrowWithFees * scale, getInterest(config.supply.baseSupplyWithFees * scale, borrowRate, config.supply.interestTimeFactor.short) + config.common.tolerances.interest.medium);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supply.baseSupplyWithFees * scale });

    expectApproximately(await albert.getCometBaseBalance(), config.supply.usdtRemainingDebt * exp(1, 6), getInterest(config.supply.baseSupplyWithFees * scale, borrowRate, config.supply.interestTimeFactor.long) + config.common.tolerances.interest.medium);

    return txn;
  }
);

scenario(
  'Comet#supply > repay all borrow with token fees',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: `==${getConfigForScenario(ctx).supply.baseSupplyWithFees}` }
    }),
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseBorrowRepayAmount }
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(String(config.supply.ethBalanceForGas)).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(config.supply.usdtFeeBasisPoints, config.supply.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(), 
      config.supply.baseBorrowRepayAmount * scale, 
      getInterest(config.supply.baseSupplyAfterFees * scale, borrowRate, config.supply.interestTimeFactor.long) + config.common.tolerances.interest.medium
    );

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supply.baseSupplyWithFees * scale });

    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(config.supply.baseSupplyWithFees * scale, borrowRate, config.supply.interestTimeFactor.long) + config.common.tolerances.interest.medium);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > base asset',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supply.baseSupplyAmount * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: config.supply.baseSupplyAmount * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(config.supply.baseSupplyAmount * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > base asset with token fees',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyWithFees },
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(String(config.supply.ethBalanceForGas)).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(config.supply.usdtFeeBasisPoints, config.supply.usdtMaxFee);

    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supply.baseSupplyWithFees * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: config.supply.baseSupplyWithFees * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance((config.supply.baseSupplyWithFees - 1n) * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > repay borrow',
  {
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: Number(getConfigForScenario(ctx).supply.baseBalance) + (0.01 * Number(getConfigForScenario(ctx).supply.baseBalance))
        }
      }
    ),
    cometBalances: async (ctx) => (
      {
        betty: {
          $base: `<= -${getConfigForScenario(ctx).supply.baseBalance}`
        }
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);
    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: UINT256_MAX });
    expect(await baseAsset.balanceOf(albert.address)).to.be.lessThan(config.supply.baseBalance * scale);
    expectBase(await betty.getCometBaseBalance(), 0n);
    return txn;
  }
);

scenario(
  'Comet#supply reverts if not enough ERC20 approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyAmount }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplyAmount }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    await baseAsset.approve(albert, betty, config.supply.baseSupplySmall * scale);

    await expect(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supply.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    await collateralAsset.approve(albert, betty, config.supply.baseSupplySmall * scale);

    await expectRevertMatches(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      }),
      [
        /ERC20: transfer amount exceeds allowance/,
        /ERC20: insufficient allowance/,
        /transfer amount exceeds spender allowance/,
        /Dai\/insufficient-allowance/,
        symbol === 'WETH' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WRON' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'wstETH' ? /0xc2139725/ : /.^/,
        symbol === 'LBTC' ? /0xfb8f41b2/ : /.^/,
        symbol === 'WMATIC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WPOL' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'sUSDS' ? /SUsds\/insufficient-allowance/ : /.^/,
        symbol === 'USDC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'GOLD' ? /Transaction reverted and Hardhat couldn't infer the reason./ : /.^/,
      ]
    );
  }
);

scenario(
  'Comet#supply reverts if not enough ERC20 balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplySmall }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expect(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supply.baseSupplySmall }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);
    await expect(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supply.baseSupplySmall }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    await expectRevertMatches(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      }),
      [
        /transfer amount exceeds balance/,
        /Dai\/insufficient-balance/,
        symbol === 'WRON' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WETH' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'wstETH' ? /0x00b284f2/ : /.^/,
        symbol === 'LBTC' ? /0xe450d38c/ : /.^/,
        symbol === 'WMATIC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WPOL' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'sUSDS' ? /SUsds\/insufficient-balance/ : /.^/,
        symbol === 'USDC' ? /Transaction reverted without a reason string/ : /.^/,
      ]
    );
  }
);

scenario(
  'Comet#supplyFrom reverts if operator not given permission',
  {
    tokenBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supply.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.supply.baseSupplyAmount * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#supply reverts when supply is paused',
  {
    pause: {
      supplyPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.supplyAsset({
        asset: baseToken,
        amount: config.supply.baseSupplyAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#supplyFrom reverts when supply is paused',
  {
    pause: {
      supplyPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.supplyAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: config.supply.baseSupplyAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#supply reverts if asset is not supported',
  {},
  async () => {
    // XXX requires deploying an unsupported asset (maybe via remote token constraint)
  }
);

scenario(
  'Comet#supply reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: BigInt(getConfigForScenario(context).transferBase) * scale,
      }),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supply reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();


    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      albert.supplyAsset({
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).supplyCollateral) * scale,
      }),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyTo reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();


    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, baseAsset.address, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyTo reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();


    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, BigInt(getConfigForScenario(context).supplyCollateral) * scale),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyTo reverts when specific collateral asset supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause specific collateral asset supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(0, true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, BigInt(getConfigForScenario(context).supplyCollateral) * scale),
      'CollateralAssetSupplyPaused(0)'
    );
  }
);

scenario(
  'Comet#supplyFrom reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();


    await baseAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await expectRevertCustom(
      charles.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: BigInt(getConfigForScenario(context).transferBase) * scale,
      }),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyFrom reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();


    await collateralAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await expectRevertCustom(
      charles.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).supplyCollateral) * scale,
      }),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyFrom reverts when specific collateral asset supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();


    await collateralAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause specific collateral asset supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(0, true);

    await expectRevertCustom(
      charles.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).supplyCollateral) * scale,
      }),
      'CollateralAssetSupplyPaused(0)'
    );
  }
);

scenario(
  'Comet#supply reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const supplyCollateral = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(supplyCollateral, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await expectRevertCustom(
        albert.supplyAsset({
          asset: collateralAsset.address,
          amount: supplyCollateral,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: supplyCollateral,
      });

      expect(await comet.collateralBalanceOf(
        albert.address, 
        collateralAsset.address
      )).to.be.equal(supplyCollateral);
    }
  }
);

scenario(
  'Comet#supplyTo reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const supplyCollateral = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(supplyCollateral, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await expectRevertCustom(
        albert.supplyAssetTo({
          dst: betty.address,
          asset: collateralAsset.address,
          amount: supplyCollateral,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await albert.safeSupplyAssetTo({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: supplyCollateral,
      });

      expect(await comet.collateralBalanceOf(
        betty.address, 
        collateralAsset.address
      )).to.be.equal(supplyCollateral);
    }
  }
);

scenario(
  'Comet#supplyFrom reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const supplyCollateral = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(supplyCollateral, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await albert.allow(betty, true);

      await expectRevertCustom(
        betty.supplyAssetFrom({
          src: albert.address,
          dst: betty.address,
          asset: collateralAsset.address,
          amount: supplyCollateral,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await betty.safeSupplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: supplyCollateral,
      });

      expect(await comet.collateralBalanceOf(
        betty.address, 
        collateralAsset.address
      )).to.be.equal(supplyCollateral);
    }
  }
);


/*//////////////////////////////////////////////////////////////
                    DEACTIVATE/ACTIVATE COLLATERALS
//////////////////////////////////////////////////////////////*/

scenario('Comet#supply reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  }, async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`Supply reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        albert.safeSupplyAsset({
          asset: asset,
          amount: supplyAmount,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supply is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: supplyAmount,
      });

      expect(await comet.collateralBalanceOf(
        albert.address, 
        collateralAsset.address
      )).to.be.equal(supplyAmount);
    }
  }
);

scenario(
  'Comet#supplyTo reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`SupplyTo reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        albert.safeSupplyAssetTo({
          dst: betty.address,
          asset: collateralAsset.address,
          amount: supplyAmount,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`SupplyTo is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await albert.safeSupplyAssetTo({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: supplyAmount,
      });

      expect(await comet.collateralBalanceOf(
        betty.address, 
        collateralAsset.address
      )).to.be.equal(supplyAmount);
    }
  }
);

scenario(
  'Comet#supplyFrom reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Allow betty to act on behalf of albert
    await albert.allow(betty, true);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`SupplyFrom reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      

      await expectRevertCustom(
        betty.supplyAssetFrom({
          src: albert.address,
          dst: betty.address,
          asset: collateralAsset.address,
          amount: supplyAmount,
        }),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`SupplyFrom is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await betty.safeSupplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: supplyAmount,
      });

      expect(await comet.collateralBalanceOf(
        betty.address, 
        collateralAsset.address
      )).to.be.equal(supplyAmount);
    }
  }
);
