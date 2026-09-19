export interface RenderPass {
  name: string;
  fragmentShader: string;
  uniforms: string[];
  textures?: string[];  // additional sampler2D uniforms (bound to unit 1, 2, ...)
}
