declare module 'onnxruntime-web' {
  export class Tensor {
    constructor(type: string, data: Float32Array | Uint8Array, dims: number[]);
    readonly data: Float32Array | Uint8Array;
    readonly dims: readonly number[];
  }

  export class InferenceSession {
    static create(path: string, options?: { executionProviders?: string[] }): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
