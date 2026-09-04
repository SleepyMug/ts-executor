export interface CounterResult {
  readonly value: number;
  /** Starts at one in every fresh subprocess module graph. */
  readonly clientInstance: number;
}

export interface CounterClient {
  increment(amount: number): Promise<CounterResult>;
}

export function createCounterClient(baseUrl: string): CounterClient;
