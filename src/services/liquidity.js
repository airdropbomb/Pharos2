/**
 * src/services/liquidity.js - Add liquidity service
 */
const { ethers } = require("ethers");
const { contract, abi } = require("../chains").utils;
const { testnet } = require("../chains");
const { createLogger } = require("../utils/logger");

class LiquidityService {
  constructor(wallet, logger, walletName) {
    this.logger = logger || createLogger("LiquidityService");
    this.wallet = wallet;
    this.walletName = walletName || "Unknown";
    this.provider = testnet.pharos.provider();
    this.router = new ethers.Contract(contract.ROUTER, abi.ROUTER, wallet);
  }

  // Utility to approve token if needed
  async approveToken(tokenAddress, spender, amount) {
    try {
      const token = new ethers.Contract(tokenAddress, abi.ERC20, this.wallet);
      const allowance = await token.allowance(this.wallet.address, spender);
      if (allowance >= amount) {
        this.logger(`System | ${this.walletName} | Token already approved for ${spender}`);
        return true;
      }

      this.logger(`System | ${this.walletName} | Approving token ${tokenAddress} for ${spender}`);
      const tx = await token.approve(spender, ethers.MaxUint256);
      await this.waitForTransaction(tx.hash, 1);
      this.logger(`System | ${this.walletName} | Approval successful for ${tokenAddress}`);
      return true;
    } catch (error) {
      this.logger(`System | ${this.walletName} | Approval failed: ${error.message}`);
      return false;
    }
  }

  // Wait for transaction with retry logic
  async waitForTransaction(txHash, confirmations, retries = 5, delay = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const receipt = await this.provider.waitForTransaction(txHash, confirmations, 60000);
        if (receipt && receipt.status === 1) {
          return receipt;
        }
        throw new Error(`Transaction ${txHash} failed or reverted`);
      } catch (error) {
        if (error.code === -32008 || error.message.includes("eth_getTransactionReceipt")) {
          this.logger(`System | ${this.walletName} | Retry ${attempt}/${retries} for tx ${txHash}: ${error.message}`);
          if (attempt === retries) {
            this.logger(`System | ${this.walletName} | Max retries reached for tx ${txHash}`);
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.logger(`System | ${this.walletName} | Transaction error: ${error.message}`);
          return null;
        }
      }
    }
    return null;
  }

  // Add liquidity for a token pair
  async addLiquidity(tokenA, tokenB, amountA, amountB) {
    try {
      // Map token symbols to addresses
      const tokenMap = {
        PHRS: contract.WPHRS,
        USDT: contract.USDT,
        USDC: contract.USDC,
      };

      const tokenAAddress = tokenMap[tokenA.toUpperCase()];
      const tokenBAddress = tokenMap[tokenB.toUpperCase()];
      if (!tokenAAddress || !tokenBAddress) {
        this.logger(`System | ${this.walletName} | Invalid token pair: ${tokenA}-${tokenB}`);
        return null;
      }

      // Determine token order (token0 should be the lower address)
      const token0 = tokenAAddress < tokenBAddress ? tokenAAddress : tokenBAddress;
      const token1 = tokenAAddress < tokenBAddress ? tokenBAddress : tokenAAddress;
      const amount0Desired = tokenAAddress === token0 ? ethers.parseEther(amountA.toString()) : ethers.parseEther(amountB.toString());
      const amount1Desired = tokenAAddress === token0 ? ethers.parseEther(amountB.toString()) : ethers.parseEther(amountA.toString());

      // Approve tokens
      const approvedA = await this.approveToken(tokenAAddress, contract.ROUTER, amount0Desired);
      const approvedB = await this.approveToken(tokenBAddress, contract.ROUTER, amount1Desired);
      if (!approvedA || !approvedB) {
        this.logger(`System | ${this.walletName} | Token approval failed for ${tokenA}-${tokenB}`);
        return null;
      }

      // Prepare mint parameters
      const params = {
        token0,
        token1,
        fee: 500, // 0.05% fee tier
        tickLower: -887220, // Full range
        tickUpper: 887220, // Full range
        amount0Desired: amount0Desired.toString(),
        amount1Desired: amount1Desired.toString(),
        amount0Min: "0",
        amount1Min: "0",
        recipient: this.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
      };

      // Encode mint and refundETH calls
      const mintData = this.router.interface.encodeFunctionData("mint", [params]);
      const refundData = this.router.interface.encodeFunctionData("refundETH", []);
      const multicallData = [mintData, refundData];

      // Estimate gas and send transaction
      const txParams = {
        to: contract.ROUTER,
        data: this.router.interface.encodeFunctionData("multicall", [multicallData]),
        value: token0 === contract.WPHRS ? amount0Desired : token1 === contract.WPHRS ? amount1Desired : 0,
        gasLimit: 500000, // Fixed gas limit
      };

      const estimatedGas = await this.provider.estimateGas(txParams).catch((e) => {
        this.logger(`System | ${this.walletName} | Gas estimation failed: ${e.message}`);
        return ethers.toBigInt(500000);
      });
      txParams.gasLimit = estimatedGas * 12n / 10n; // Add 20% buffer

      this.logger(`System | ${this.walletName} | Sending liquidity transaction for ${amountA} ${tokenA} + ${amountB} ${tokenB}`);
      const tx = await this.wallet.sendTransaction(txParams);
      this.logger(`System | ${this.walletName} | Transaction sent: ${tx.hash}`);

      // Wait for transaction
      const receipt = await this.waitForTransaction(tx.hash, 1);
      if (receipt) {
        this.logger(`System | ${this.walletName} | Liquidity added successfully: ${tx.hash}`);
        return tx.hash;
      } else {
        this.logger(`System | ${this.walletName} | Failed to confirm liquidity transaction: ${tx.hash}`);
        return null;
      }
    } catch (error) {
      this.logger(`System | ${this.walletName} | Error adding liquidity: ${error.message}`);
      return null;
    }
  }
}

module.exports = LiquidityService;
