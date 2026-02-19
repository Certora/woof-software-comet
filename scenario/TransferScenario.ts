import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, getInterest, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS, fundAccount, usesAssetList, isAssetDelisted, supportsExtendedPause } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';
import { defactor } from '../test/helpers';
import { log } from 'console';

async function testTransferCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  // Albert transfers 50 units of collateral to Betty
  const toTransfer = scale.toBigInt() * BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer;
  const txn = await albert.transferAsset({ dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));

  return txn;
}

async function testTransferFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty, charles } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  await albert.allow(charles, true);

  // Charles transfers 50 units of collateral from Albert to Betty
  const toTransfer = scale.toBigInt() * BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer;
  const txn = await charles.transferAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));

  return txn;
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transfer > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).transfer.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transferFrom > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).transfer.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#transfer > base asset, enough balance',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert transfers half supplied base to Betty
    const toTransfer = baseSupplied / config.common.divisors.transfer;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectBase(await albert.getCometBaseBalance(), baseSupplied - toTransfer, baseSupplied / config.common.divisors.percent);
    expectBase(await betty.getCometBaseBalance(), toTransfer, baseSupplied / config.common.divisors.percent);

    return txn;
  }
);

scenario(
  'Comet#transfer > base asset, total and user balances are summed up properly',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Cache pre-transfer balances
    const { totalSupplyBase: oldTotalSupply, totalBorrowBase: oldTotalBorrow } = await comet.totalsBasic();
    const oldAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const oldBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Albert transfers 50 units of collateral to Betty
    const toTransfer = BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer * scale;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Cache post-transfer balances
    const { totalSupplyBase: newTotalSupply, totalBorrowBase: newTotalBorrow } = await comet.totalsBasic();
    const newAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const newBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Check that global and user principals are updated by the same amount
    const changeInTotalPrincipal = newTotalSupply.toBigInt() - oldTotalSupply.toBigInt() - (newTotalBorrow.toBigInt() - oldTotalBorrow.toBigInt());
    const changeInUserPrincipal = newAlbertPrincipal - oldAlbertPrincipal + newBettyPrincipal - oldBettyPrincipal;
    expect(changeInTotalPrincipal).to.be.equal(changeInUserPrincipal).to;
    expect(config.transfer.principalToleranceValues).to.include(changeInTotalPrincipal);

    return txn;
  }
);

scenario(
  'Comet#transfer > partial withdraw / borrow base to partial repay / supply',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: { $base: getConfigForScenario(ctx).transfer.baseAmount, $asset0: getConfigForScenario(ctx).common.cometBalances.collateral.asset0CometBalance },
        betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
        charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      BigInt(config.transfer.baseAmount) * scale,
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    expectApproximately(
      await betty.getCometBaseBalance(),
      -BigInt(config.transfer.baseAmount) * scale,
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = BigInt(config.transfer.baseAmount) * config.transfer.multiplier.num / config.transfer.multiplier.denom * scale;
    await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Albert ends with negative balance and Betty with positive balance
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, getInterest(BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.large);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, getInterest(BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.large);
  }
);

scenario(
  'Comet#transferFrom > withdraw to repay',
  {
    cometBalances: async (ctx) => ({
      albert: { 
        $base: getConfigForScenario(ctx).common.cometBalances.base, 
        $asset0: getConfigForScenario(ctx).common.cometBalances.collateral.asset0CometBalance 
      },
      betty: { $base: -getConfigForScenario(ctx).common.cometBalances.base },
      charles: { $base: getConfigForScenario(ctx).common.cometBalances.base },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), BigInt(config.common.cometBalances.base) * scale, getInterest(BigInt(config.common.cometBalances.base) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(-config.common.cometBalances.base) * scale, getInterest(BigInt(config.common.cometBalances.base) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);

    await albert.allow(betty, true);

    const toTransfer = (config.common.cometBalances.base - 1n) * scale;
    await betty.transferAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectApproximately(await albert.getCometBaseBalance(), config.transfer.remainingBalance * scale, getInterest(BigInt(config.common.cometBalances.base) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);
    expectApproximately(await betty.getCometBaseBalance(), -config.transfer.remainingBalance * scale, getInterest(BigInt(config.common.cometBalances.base) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);
  }
);

scenario(
  'Comet#transfer base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { 
        $base: getConfigForScenario(ctx).transfer.baseAmount,
        $asset0: defactor(getConfigForScenario(ctx).common.cometBalances.collateral.undercollateralized) 
      },
      betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
      charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(), 
      BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    expectApproximately(
      await betty.getCometBaseBalance(), 
      -BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = config.transfer.overLimit * scale;
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { 
        $base: getConfigForScenario(ctx).transfer.baseAmount,
        $asset0: defactor(getConfigForScenario(ctx).common.cometBalances.collateral.undercollateralized) 
      },
      betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
      charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(), 
      BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    expectApproximately(
      await betty.getCometBaseBalance(), 
      -BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    
    await albert.allow(betty, true);

    const toTransfer = config.transfer.overLimit * scale;
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer collateral reverts if undercollateralized',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        },
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    // Albert transfers all his collateral to Betty
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(config.transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom collateral reverts if undercollateralized',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        },
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);

    // Betty transfers all of Albert's collateral to herself
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(config.transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of base',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: baseToken,
        amount: config.transfer.baseAmount,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of collateral',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: collateralAsset.asset,
        amount: config.transfer.collateralAmount,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of base',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: baseToken,
        amount: config.transfer.baseAmount,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of collateral',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: collateralAsset.asset,
        amount: config.transfer.collateralAmount,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts if operator not given permission',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.transfer.baseAmount * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#transfer reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseToken,
        amount: config.transfer.baseAmount,
      }),
      'Paused()'
    );
  }
);


scenario(
  'Comet#transferFrom reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: config.transfer.baseAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#transfer reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: async (ctx) => ({
      albert: { $base: 0, $asset0: getConfigForScenario(ctx).transfer.collateralAmount }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: minBorrow / config.common.divisors.transfer
      }),
      'BorrowTooSmall()'
    );
  }
);

scenario(
  'Comet#transfer reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
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

    // Pause collateral transfer
    await cometExt.connect(pauseGuardian.signer).pauseCollateralTransfer(true);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transferCollateral) * scale
      }),
      'CollateralTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();


    await albert.allow(betty, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral transfer
    await cometExt.connect(pauseGuardian.signer).pauseCollateralTransfer(true);

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: charles.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transferCollateral) * scale
      }),
      'CollateralTransferPaused()'
    );
  }
);

scenario(
  'Comet#transfer reverts when borrowers transfer is paused',
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
        albert: { $base: '== 0' },
        betty: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $base: -getConfigForScenario(ctx).transferBase, $asset0: getConfigForScenario(ctx).transferAsset },
        charles: { $base: getConfigForScenario(ctx).transferBase } // to give the protocol enough base for others to borrow from
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

    // Pause borrowers transfer
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: BigInt(getConfigForScenario(context).transferBase) * scale
      }),
      'BorrowersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts when borrowers transfer is paused',
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
        albert: { $base: '== 0' },
        $comet: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).transferAsset }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();


    await albert.allow(betty, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause borrowers transfer
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: BigInt(getConfigForScenario(context).transferBase) * scale
      }),
      'BorrowersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transfer reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();


    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause lenders transfer
    await cometExt.connect(pauseGuardian.signer).pauseLendersTransfer(true);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: baseSupplied
      }),
      'LendersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { $base: getConfigForScenario(ctx).transferBase }
      }
    ),
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();


    await albert.allow(betty, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause lenders transfer
    await cometExt.connect(pauseGuardian.signer).pauseLendersTransfer(true);

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: baseSupplied
      }),
      'LendersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transfer reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await supportsExtendedPause(ctx);
    },
    cometBalances: async (ctx: CometContext) => (
      {
        albert: { 
          $asset0: getConfigForScenario(ctx).transferCollateral
        }
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

    // Pause only asset0 transfer
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(0, true);

    // Asset0 transfer should revert
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transferCollateral) * scale
      }),
      'CollateralAssetTransferPaused(0)'
    );
  }
);


scenario(
  'Comet#transfer reverts when collateral asset transfer is paused and allows to transfer when unpaused',
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
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferCollateral = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Source collateral asset
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: transferCollateral,
      });

      // Pause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      await expectRevertCustom(
        albert.transferAsset({
          dst: betty.address,
          asset: collateralAsset.address,
          amount: transferCollateral,
        }),
        `CollateralAssetTransferPaused(${i})`
      );

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

      // Save balances 
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Transfer asset from albert to betty
      await albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: transferCollateral,
      });

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferCollateral);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferCollateral);
    }
  }
);

scenario(
  'Comet#transferFrom reverts when collateral asset transfer is paused and allows to transfer when unpaused',
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
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferCollateral = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Fund pause guardian account for gas fees
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: transferCollateral,
      });

      // Pause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      // Allow betty to transfer asset from albert
      await albert.allow(betty, true);

      await expectRevertCustom(
        betty.transferAssetFrom({
          src: albert.address,
          dst: betty.address,
          asset: collateralAsset.address,
          amount: transferCollateral,
        }),
        `CollateralAssetTransferPaused(${i})`
      );

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

      // Save balances 
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Transfer asset from albert to betty
      await betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transferCollateral) * scale,
      });

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferCollateral);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferCollateral);
    }
  }
);

/*//////////////////////////////////////////////////////////////
                    DEACTIVATE/ACTIVATE COLLATERALS
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#transferFrom reverts when collateral asset is deactivated and allows to transfer when activated',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await supportsExtendedPause(ctx);
    },
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Allow betty to act on behalf of albert
    await albert.allow(betty, true);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`TransferFrom reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: transferAmount,
      });

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        betty.transferAssetFrom({
          src: albert.address,
          dst: charles.address,
          asset: collateralAsset.address,
          amount: transferAmount,
        }),
        `CollateralAssetTransferPaused(${i})`
      );

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      log(`TransferFrom is allowed when collateral asset ${i} is activated`);

      // Save balances 
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const charlesBalanceBefore = await comet.collateralBalanceOf(charles.address, collateralAsset.address);

      await betty.transferAssetFrom({
        src: albert.address,
        dst: charles.address,
        asset: collateralAsset.address,
        amount: transferAmount,
      });

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const charlesBalanceAfter = await comet.collateralBalanceOf(charles.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferAmount);
      expect(charlesBalanceAfter).to.be.equal(charlesBalanceBefore.toBigInt() + transferAmount);
    }
  }
);

scenario(
  'Comet#transfer reverts when collateral asset is deactivated and allows to transfer when activated',
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
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transfer reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: transferAmount,
      });

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        albert.transferAsset({
          dst: betty.address,
          asset: collateralAsset.address,
          amount: transferAmount,
        }),
        `CollateralAssetTransferPaused(${i})`
      );

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      log(`Transfer is allowed when collateral asset ${i} is activated`);

      // Save balances 
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      await albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: transferAmount,
      });

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferAmount);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferAmount);
    }
  }
);