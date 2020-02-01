// tslint:disable-next-line:no-submodule-imports
import 'cross-fetch/polyfill';
import { GraphQLClient } from 'graphql-request';
import randomBytes from 'random-bytes';
import {
  DEFAULT_CONSENSUS_INTERVAL,
  DEFAULT_TIMEOUT_GAP
} from '../core/constant';
import { toHex } from '../utils';
import { getSdk, InputRawTransaction } from './codegen/sdk';
import { Retry } from './retry';

interface CallService<Pld> {
  timeout?: string;
  serviceName: string;
  method: string;
  payload: Pld;
}

interface ClientOption {
  entry: string;
  chainId: string;
  maxTimeout: number;
}

type RawClient = ReturnType<typeof getSdk>;

/**
 * Client for call Muta GraphQL API
 */
export class Client {
  private readonly rawClient: RawClient;

  /**
   * GraphQL endpoint, ie. htto://127.0.0.1:8000/graphql
   */
  private readonly endpoint: string;
  /**
   * the ChainID
   */
  private readonly chainId: string;

  private readonly options: ClientOption;

  constructor(options: ClientOption) {
    this.endpoint = options.entry;
    this.chainId = options.chainId;

    this.options = options;

    this.rawClient = getSdk(
      new GraphQLClient(this.endpoint, {
        cache: 'no-cache'
      })
    );
  }

  public getRawClient(): RawClient {
    return this.rawClient;
  }

  /**
   * get latest block height
   */
  public async getLatestBlockHeight(): Promise<number> {
    const res = await this.rawClient.getBlock();
    const height = res.getBlock.header.height;
    return Number('0x' + height);
  }

  public async prepareTransaction<Pld>(
    tx: CallService<Pld>
  ): Promise<InputRawTransaction> {
    const timeout = await (tx.timeout
      ? Promise.resolve(tx.timeout)
      : toHex((await this.getLatestBlockHeight()) + DEFAULT_TIMEOUT_GAP - 1));

    return {
      chainId: this.chainId,
      // TODO change cyclesLimit by last block
      cyclesLimit: '0x9999',
      // TODO change cyclesLimit by last block
      cyclesPrice: '0x9999',
      nonce: toHex(randomBytes.sync(32).toString('hex')),
      timeout,
      ...tx,
      payload: JSON.stringify(tx.payload)
    };
  }

  /**
   * sendTransaction
   * @param signedTransaction
   */
  public async sendTransaction<R>(
    signedTransaction: SignedTransaction<R>
  ): Promise<string> {
    const inputRaw = signedTransaction.inputRaw;

    const rawPayload = inputRaw.payload;
    const payload =
      typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

    const res = await this.rawClient.sendTransaction({
      inputEncryption: signedTransaction.inputEncryption,
      inputRaw: { ...inputRaw, payload }
    });

    return res.sendTransaction;
  }

  public async queryService<Ret, Pld extends string | object>(
    variables: ServicePayload<Pld>
  ): Promise<{
    isError: boolean;
    ret: Ret;
  }> {
    const payload: string =
      typeof variables.payload !== 'string'
        ? JSON.stringify(variables.payload)
        : variables.payload;

    const parsedPayload = { ...variables, payload };
    const res = await this.rawClient.queryService(parsedPayload);

    return {
      isError: res.queryService.isError,
      ret: JSON.parse(res.queryService.ret) as Ret
    };
  }

  public async getReceipt(txHash) {
    const timeout = Math.max(
      this.options.maxTimeout,
      (DEFAULT_TIMEOUT_GAP + 1) * DEFAULT_CONSENSUS_INTERVAL
    );
    const res = await Retry.from(() => this.rawClient.getReceipt({ txHash }))
      .withTimeout(timeout)
      .start();

    return res.getReceipt.response.ret;
  }

  /**
   * wait for next _n_ block
   * @example
   * ```typescript
   * async main() {
   *   const before =  await client.getLatestBlockHeight();
   *   await client.waitForNextNBlock(2);
   *   const after =  await client.getLatestBlockHeight();
   *   console.log(after - before);
   * }
   * ```
   * @param n block count
   */
  public async waitForNextNBlock(n: number) {
    const before = await this.getLatestBlockHeight();
    const timeout = Math.max(
      (n + 1) * DEFAULT_CONSENSUS_INTERVAL,
      this.options.maxTimeout
    );
    return Retry.from(() => this.getLatestBlockHeight())
      .withCheck(height => height - before >= n)
      .withInterval(1000)
      .withTimeout(timeout)
      .start();
  }
}
