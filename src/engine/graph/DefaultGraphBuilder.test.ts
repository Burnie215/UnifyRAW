import { describe, expect, it } from 'vitest';
import {
  buildDefaultGraph,
  buildLayeredGraph,
  layeredParamsByNode,
  paramsByNodeFromAdjustments,
  syncDefaultNodeParams,
  syncLayeredNodeParams,
  graphMatchesLayers,
  maskNodeIdForLayer,
  KIND_COMPOSITE,
  KIND_IMAGE_BITMAP_SOURCE,
  KIND_RAW16_SOURCE,
  KIND_LENS_CORRECTION,
  KIND_TONE,
  KIND_WHITE_BALANCE,
  KIND_TONE_CURVE,
  KIND_HSL,
  KIND_HSL_DETAIL,
  KIND_CUSTOM_HSL,
  KIND_LEVELS,
  KIND_BW,
  KIND_COLOR_GRADING,
  KIND_CLARITY,
  KIND_TEXTURE,
  KIND_DENOISE,
  KIND_SHARPEN,
  KIND_EFFECTS,
  KIND_TRANSFORM,
  KIND_WHITE_BALANCE_RAW,
  KIND_COLOR_MATRIX,
  KIND_OUTPUT_COLOR_SPACE,
  registerBuiltinSources,
  registerBuiltinPassKinds,
  registerBuiltinConverts,
  type WhiteBalanceRawParams,
  type ColorMatrixParams,
  type OutputColorSpaceParams,
} from './index';
import {
  ABSOLUTE_FIELDS,
  adjustmentsToBuilderAdjustments,
  chainKindsForSource,
  chainStepsForSource,
  stageOfNodeId,
  type BuilderLayer,
} from './DefaultGraphBuilder';
import { GraphCompiler } from './GraphCompiler';
import { NodeRegistry } from './NodeRegistry';
import { registerAllBuiltins } from './registerBuiltins';
import { raw16Source } from './projection/projectionFixtures';
import { defaultAdjustments } from '../../types';

const baseGeometry = { width: 64, height: 32, pixelRatio: 1 };

describe('buildDefaultGraph', () => {
  it('emits Source + linear block + OutputColorSpace + gamma block in Lightroom order (Phase 2)', () => {
    const { graph, sourceNodeId } = buildDefaultGraph(
      {},
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    expect(sourceNodeId).toBe(`default:${KIND_IMAGE_BITMAP_SOURCE}`);
    // source + 11 linear + 1 OutputColorSpace + 5 gamma = 18 nodes.
    expect(graph.nodes.size).toBe(18);
    expect(graph.output).toBe(`default:${KIND_TRANSFORM}`);

    const expectedOrder = [
      KIND_IMAGE_BITMAP_SOURCE,
      // linear block
      KIND_LENS_CORRECTION,
      KIND_TONE, KIND_WHITE_BALANCE, KIND_TONE_CURVE, KIND_LEVELS,
      KIND_HSL, KIND_HSL_DETAIL, KIND_CUSTOM_HSL, KIND_BW,
      KIND_COLOR_GRADING, KIND_CLARITY,
      // linear → gamma bridge
      KIND_OUTPUT_COLOR_SPACE,
      // gamma block
      KIND_TEXTURE, KIND_DENOISE, KIND_SHARPEN, KIND_EFFECTS, KIND_TRANSFORM,
    ];
    const fromMap = new Map(graph.edges.map((e) => [e.from.node, e.to.node]));
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const prev = `default:${expectedOrder[i]}`;
      const next = `default:${expectedOrder[i + 1]}`;
      expect(fromMap.get(prev)).toBe(next);
    }
  });

  it('divides tone-style adjustments by 100', () => {
    const { graph } = buildDefaultGraph(
      { exposure: 50, contrast: -25, temperature: 30, vibrance: 80 },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const tone = graph.nodes.get(`default:${KIND_TONE}`)!.params as {
      exposure: number; contrast: number;
    };
    expect(tone.exposure).toBeCloseTo(0.5);
    expect(tone.contrast).toBeCloseTo(-0.25);

    const wb = graph.nodes.get(`default:${KIND_WHITE_BALANCE}`)!.params as { temperature: number };
    expect(wb.temperature).toBeCloseTo(0.3);

    const hsl = graph.nodes.get(`default:${KIND_HSL}`)!.params as { vibrance: number };
    expect(hsl.vibrance).toBeCloseTo(0.8);
  });

  it('normalises the color-grading arc sliders from editor to shader units', () => {
    const { graph } = buildDefaultGraph(
      {
        colorGrading: {
          shadows: { hue: 210, saturation: 12, satAdj: 25, lumAdj: -40 },
          midtones: { satAdj: -15, lumAdj: 10 },
          highlights: { satAdj: 60, lumAdj: -5 },
        },
      },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const grading = graph.nodes.get(`default:${KIND_COLOR_GRADING}`)!.params as {
      shadows: { hue: number; saturation: number; satAdj: number; lumAdj: number };
      midtones: { satAdj: number; lumAdj: number };
      highlights: { satAdj: number; lumAdj: number };
    };

    expect(grading.shadows).toMatchObject({ hue: 210, saturation: 12 });
    expect(grading.shadows.satAdj).toBeCloseTo(0.25);
    expect(grading.shadows.lumAdj).toBeCloseTo(-0.4);
    expect(grading.midtones.satAdj).toBeCloseTo(-0.15);
    expect(grading.midtones.lumAdj).toBeCloseTo(0.1);
    expect(grading.highlights.satAdj).toBeCloseTo(0.6);
    expect(grading.highlights.lumAdj).toBeCloseTo(-0.05);
  });

  it('normalises every remaining shader-scale editor control exactly once', () => {
    const { graph } = buildDefaultGraph(
      {
        clarity: -35,
        dehaze: 42,
        texture: -25,
        sharpness: 150,
        denoiseLuma: 20,
        denoiseChroma: 30,
        denoiseDetail: 65,
        vignette: -45,
        vignetteFeather: 70,
        grain: 55,
        grainSize: 40,
        perspectiveH: 25,
        perspectiveV: -30,
        distortion: 15,
        hsl: { red: { hue: 10, saturation: 20, luminance: -30 } },
        bwEnabled: true,
        bwMix: { red: 40 },
      },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );

    expect(graph.nodes.get(`default:${KIND_CLARITY}`)!.params).toMatchObject({ clarity: -0.35, dehaze: 0.42 });
    expect(graph.nodes.get(`default:${KIND_TEXTURE}`)!.params).toMatchObject({ amount: -0.25 });
    expect(graph.nodes.get(`default:${KIND_SHARPEN}`)!.params).toMatchObject({ sharpness: 1.5 });
    expect(graph.nodes.get(`default:${KIND_DENOISE}`)!.params).toMatchObject({ luma: 0.2, chroma: 0.3, detail: 0.65 });
    expect(graph.nodes.get(`default:${KIND_EFFECTS}`)!.params).toMatchObject({
      vignette: -0.45, vignetteFeather: 0.7, grain: 0.55, grainSize: 40,
    });
    expect(graph.nodes.get(`default:${KIND_TRANSFORM}`)!.params).toMatchObject({
      perspectiveH: 0.25, perspectiveV: -0.3, distortion: 0.15,
    });

    // These two passes intentionally keep editor units because their shaders
    // perform the /100 conversion themselves.
    const hslDetail = graph.nodes.get(`default:${KIND_HSL_DETAIL}`)!.params as { channels: { red: object } };
    expect(hslDetail.channels.red).toMatchObject({ hue: 10, saturation: 20, luminance: -30 });
    const bw = graph.nodes.get(`default:${KIND_BW}`)!.params as { mix: { red: number } };
    expect(bw.mix.red).toBe(40);
  });

  it('normalises levels endpoints from 0..255 to 0..1', () => {
    const { graph } = buildDefaultGraph(
      { levels: { rgb: { inBlack: 25, inWhite: 230, gamma: 1.5 } } },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const levels = graph.nodes.get(`default:${KIND_LEVELS}`)!.params as {
      rgb: { inBlack: number; inWhite: number; gamma: number };
    };
    expect(levels.rgb.inBlack).toBeCloseTo(25 / 255);
    expect(levels.rgb.inWhite).toBeCloseTo(230 / 255);
    expect(levels.rgb.gamma).toBe(1.5);
  });

  it('merges partial BW mix onto identity defaults', () => {
    const { graph } = buildDefaultGraph(
      { bwEnabled: true, bwMix: { red: 40, blue: -20 } },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const bw = graph.nodes.get(`default:${KIND_BW}`)!.params as {
      enabled: boolean; mix: Record<string, number>;
    };
    expect(bw.enabled).toBe(true);
    expect(bw.mix.red).toBe(40);
    expect(bw.mix.blue).toBe(-20);
    // Untouched channels default to 0.
    expect(bw.mix.green).toBe(0);
    expect(bw.mix.magenta).toBe(0);
  });

  it('normalises sharpness from 0..100 to 0..1', () => {
    const { graph } = buildDefaultGraph(
      { sharpness: 60 },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const sharpen = graph.nodes.get(`default:${KIND_SHARPEN}`)!.params as { sharpness: number };
    expect(sharpen.sharpness).toBeCloseTo(0.6);
  });

  it('derives persisted skin-tone uniformity without a color-editor mode gate', () => {
    const skinToneSector = {
      ...defaultAdjustments.skinToneSector,
      hueCenter: 350,
      hueHalfWidth: 20,
      satMin: 10,
      satMax: 90,
      pickRelHue: 0.25,
      pickRelSat: 0.75,
      selLightness: 20,
    };
    const builder = adjustmentsToBuilderAdjustments({
      ...defaultAdjustments,
      colorEditorMode: 'basic',
      skinToneSector,
      skinToneUniformity: { hue: 30, saturation: 0, luminance: 0 },
    });
    const params = paramsByNodeFromAdjustments(builder, {
      kind: 'imageBitmap', geometry: baseGeometry,
    }).get(`default:${KIND_HSL_DETAIL}`) as {
      skinTone?: Record<string, number>;
    };

    expect(params.skinTone).toEqual({
      refHue: 340,
      refSat: 70,
      refLum: 60,
      uniHue: 0.3,
      uniSat: 0,
      uniLum: 0,
      halfWidth: 20,
    });
  });

  it('leaves the HSL detail skin-tone params inactive at zero uniformity', () => {
    const builder = adjustmentsToBuilderAdjustments({
      ...defaultAdjustments,
      skinToneUniformity: { hue: 0, saturation: 0, luminance: 0 },
    });
    const params = paramsByNodeFromAdjustments(builder, {
      kind: 'imageBitmap', geometry: baseGeometry,
    }).get(`default:${KIND_HSL_DETAIL}`) as { skinTone?: unknown };

    expect(params.skinTone).toBeUndefined();
  });

  it('lets a layer without its own uniformity inherit the base skin-tone params', () => {
    const base = adjustmentsToBuilderAdjustments({
      ...defaultAdjustments,
      skinToneUniformity: { hue: 40, saturation: 15, luminance: 5 },
    });
    const layers: BuilderLayer[] = [{
      id: 'inherits', adjustments: { exposure: 10 }, opacity: 1, blendMode: 'normal',
    }];
    const params = layeredParamsByNode(base, layers, {
      kind: 'imageBitmap', geometry: baseGeometry,
    });

    const baseHsl = params.get(`default:${KIND_HSL_DETAIL}`) as { skinTone?: unknown };
    const layerHsl = params.get(`layer:inherits:default:${KIND_HSL_DETAIL}`) as { skinTone?: unknown };
    expect(layerHsl.skinTone).toEqual(baseHsl.skinTone);
  });

  it('lets an explicit zero layer uniformity switch off a nonzero base', () => {
    const base = adjustmentsToBuilderAdjustments({
      ...defaultAdjustments,
      skinToneUniformity: { hue: 40, saturation: 15, luminance: 5 },
    });
    const off = adjustmentsToBuilderAdjustments({
      skinToneUniformity: { hue: 0, saturation: 0, luminance: 0 },
    });
    const layers: BuilderLayer[] = [{
      id: 'off', adjustments: off, opacity: 1, blendMode: 'normal',
    }];
    const params = layeredParamsByNode(base, layers, {
      kind: 'imageBitmap', geometry: baseGeometry,
    });

    const baseHsl = params.get(`default:${KIND_HSL_DETAIL}`) as { skinTone?: unknown };
    const layerHsl = params.get(`layer:off:default:${KIND_HSL_DETAIL}`) as { skinTone?: unknown };
    expect(baseHsl.skinTone).toBeDefined();
    expect(layerHsl.skinTone).toBeUndefined();
  });

  // Unit boundary, like sharpness above: Adjustments (and so BuilderAdjustments)
  // carries rotation in degrees - that is what the slider, the straighten tool
  // and the CSS fallback all speak - while TransformParams carries radians, as
  // the shader uniform and the node inspector expect. This test used to assert
  // a straight pass-through, which is how degrees reached the shader as radians
  // and made every straighten 180/pi times too strong.
  it('converts transform rotation from degrees to radians', () => {
    const { graph } = buildDefaultGraph(
      { rotation: 45, flipH: true },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const t = graph.nodes.get(`default:${KIND_TRANSFORM}`)!.params as {
      rotation: number; flipH: boolean; flipV: boolean;
    };
    expect(t.rotation).toBeCloseTo(Math.PI / 4);
    expect(t.flipH).toBe(true);
    expect(t.flipV).toBe(false);
  });
});

describe('DefaultGraphBuilder + GraphCompiler integration', () => {
  function setupRegistry(): NodeRegistry {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    registerBuiltinSources(r);
    registerBuiltinPassKinds(r);
    return r;
  }

  it('identity adjustments still mark every SDR pass as identity-skipped (Phase 2)', async () => {
    const registry = setupRegistry();
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry });
    const plan = await new GraphCompiler(registry).compile(graph);
    // Phase 2 layout: gamma source → [auto convert] → linear block →
    // OutputColorSpace (linear→gamma) → gamma block. Multiple segments by
    // construction; identity-skip is still per-node.
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    for (const kind of [
      KIND_LENS_CORRECTION,
      KIND_TONE, KIND_WHITE_BALANCE, KIND_TONE_CURVE, KIND_LEVELS,
      KIND_HSL, KIND_HSL_DETAIL, KIND_CUSTOM_HSL, KIND_BW,
      KIND_COLOR_GRADING, KIND_CLARITY, KIND_TEXTURE, KIND_DENOISE,
      KIND_SHARPEN, KIND_EFFECTS, KIND_TRANSFORM,
    ]) {
      expect(plan.identitySkips.has(`default:${kind}`)).toBe(true);
    }
  });

  it('keeps an exact zero-degree skin reference active in the HSL detail node', async () => {
    const registry = setupRegistry();
    const builder = adjustmentsToBuilderAdjustments({
      ...defaultAdjustments,
      skinToneSector: {
        ...defaultAdjustments.skinToneSector,
        hueCenter: 330,
        hueHalfWidth: 60,
        pickRelHue: 0.75,
      },
      skinToneUniformity: { hue: 100, saturation: 0, luminance: 0 },
    });
    const { graph } = buildDefaultGraph(builder, {
      kind: 'imageBitmap', geometry: baseGeometry,
    });
    const params = graph.nodes.get(`default:${KIND_HSL_DETAIL}`)!.params as {
      skinTone?: { refHue: number; uniHue: number };
    };
    const plan = await new GraphCompiler(registry).compile(graph);

    expect(params.skinTone).toMatchObject({ refHue: 0, uniHue: 1 });
    expect(plan.identitySkips.has(`default:${KIND_HSL_DETAIL}`)).toBe(false);
  });

  it('treats extra control points on the tone-curve diagonal as identity', async () => {
    const registry = setupRegistry();
    const { graph } = buildDefaultGraph(
      {
        toneCurve: {
          rgb: [
            { x: 0, y: 0 },
            { x: 0.25, y: 0.25 },
            { x: 0.5, y: 0.5 },
            { x: 0.75, y: 0.75 },
            { x: 1, y: 1 },
          ],
        },
      },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const plan = await new GraphCompiler(registry).compile(graph);
    expect(plan.identitySkips.has(`default:${KIND_TONE_CURVE}`)).toBe(true);
  });

  it('non-identity adjustments leave skip-set partial', async () => {
    const registry = setupRegistry();
    const { graph } = buildDefaultGraph(
      { exposure: 50, sharpness: 30, bwEnabled: true },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const plan = await new GraphCompiler(registry).compile(graph);
    expect(plan.identitySkips.has(`default:${KIND_TONE}`)).toBe(false);
    expect(plan.identitySkips.has(`default:${KIND_SHARPEN}`)).toBe(false);
    expect(plan.identitySkips.has(`default:${KIND_BW}`)).toBe(false);
    // Untouched ones still identity.
    expect(plan.identitySkips.has(`default:${KIND_HSL}`)).toBe(true);
    expect(plan.identitySkips.has(`default:${KIND_TRANSFORM}`)).toBe(true);
  });

  it('terminal geometry equals source geometry (no resizers in default chain)', async () => {
    const registry = setupRegistry();
    const geom = { width: 1024, height: 768, pixelRatio: 1 };
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: geom });
    const plan = await new GraphCompiler(registry).compile(graph);
    expect(plan.perNodeFbo.get(`default:${KIND_TRANSFORM}`)?.geometry).toEqual(geom);
  });

  it('topological order matches Lightroom chain (Phase 2 layout with OCS in middle)', async () => {
    const registry = setupRegistry();
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry });
    const plan = await new GraphCompiler(registry).compile(graph);
    const topo = plan.topologicalOrder;
    const idx = (k: string) => topo.indexOf(`default:${k}`);
    const expected = [
      KIND_IMAGE_BITMAP_SOURCE,
      KIND_LENS_CORRECTION,
      KIND_TONE, KIND_WHITE_BALANCE, KIND_TONE_CURVE, KIND_LEVELS,
      KIND_HSL, KIND_HSL_DETAIL, KIND_CUSTOM_HSL, KIND_BW,
      KIND_COLOR_GRADING, KIND_CLARITY,
      KIND_OUTPUT_COLOR_SPACE,
      KIND_TEXTURE, KIND_DENOISE, KIND_SHARPEN, KIND_EFFECTS, KIND_TRANSFORM,
    ];
    for (let i = 0; i < expected.length - 1; i++) {
      expect(idx(expected[i])).toBeLessThan(idx(expected[i + 1]));
    }
  });
});

// ─── raw16 HDR-chain coverage ──────────────────────────────────────

describe('buildDefaultGraph (raw16)', () => {
  it('wraps SDR chain in WhiteBalanceRaw + ColorMatrix → adjustments → OutputColorSpace', () => {
    const { graph, sourceNodeId } = buildDefaultGraph(
      {},
      raw16Source({
        geometry: baseGeometry,
        calibration: { asShotNeutral: [2.1, 1, 1.4], colorMatrix: [
          1.5, -0.3, -0.2,
          -0.1, 1.4, -0.3,
          0,    -0.2, 1.2,
        ] },
      }),
    );
    expect(sourceNodeId).toBe(`default:${KIND_RAW16_SOURCE}`);
    // raw16 source + 2 HDR-pre + 10 linear + 1 OCS + 5 gamma = 19 nodes.
    // The additive SDR white-balance node is intentionally absent.
    expect(graph.nodes.size).toBe(19);
    // Terminal is the last gamma-block kind (Transform) in Phase 2 layout.
    expect(graph.output).toBe(`default:${KIND_TRANSFORM}`);

    // Verify chain shape via the from→to edge map.
    const expectedOrder = [
      KIND_RAW16_SOURCE,
      KIND_WHITE_BALANCE_RAW, KIND_COLOR_MATRIX,
      KIND_LENS_CORRECTION,
      KIND_TONE, KIND_TONE_CURVE, KIND_LEVELS,
      KIND_HSL, KIND_HSL_DETAIL, KIND_CUSTOM_HSL, KIND_BW,
      KIND_COLOR_GRADING, KIND_CLARITY,
      KIND_OUTPUT_COLOR_SPACE,
      KIND_TEXTURE, KIND_DENOISE, KIND_SHARPEN, KIND_EFFECTS, KIND_TRANSFORM,
    ];
    const fromMap = new Map(graph.edges.map((e) => [e.from.node, e.to.node]));
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const prev = `default:${expectedOrder[i]}`;
      const next = `default:${expectedOrder[i + 1]}`;
      expect(fromMap.get(prev)).toBe(next);
    }

    // Calibration flows from source spec into the raw passes.
    const wbRaw = graph.nodes.get(`default:${KIND_WHITE_BALANCE_RAW}`)!.params as WhiteBalanceRawParams;
    expect(wbRaw.wb).toEqual([2.1, 1, 1.4]);
    expect(graph.nodes.has(`default:${KIND_WHITE_BALANCE}`)).toBe(false);
    const cm = graph.nodes.get(`default:${KIND_COLOR_MATRIX}`)!.params as ColorMatrixParams;
    expect(cm.matrix[0]).toBeCloseTo(1.5);
    expect(cm.matrix[4]).toBeCloseTo(1.4);
  });

  it('falls back to identity calibration when source carries none', () => {
    const { graph } = buildDefaultGraph(
      {},
      raw16Source({ geometry: baseGeometry }),
    );
    const wbRaw = graph.nodes.get(`default:${KIND_WHITE_BALANCE_RAW}`)!.params as WhiteBalanceRawParams;
    expect(wbRaw.wb).toEqual([1, 1, 1]);
    const cm = graph.nodes.get(`default:${KIND_COLOR_MATRIX}`)!.params as ColorMatrixParams;
    expect(cm.matrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const ocs = graph.nodes.get(`default:${KIND_OUTPUT_COLOR_SPACE}`)!.params as OutputColorSpaceParams;
    expect(ocs.gammaType).toBe(0); // sRGB default
    expect(ocs.matrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('honours outputColorSpaceId on source spec', () => {
    const { graph } = buildDefaultGraph(
      {},
      raw16Source({ geometry: baseGeometry, outputColorSpaceId: 'adobe-rgb' }),
    );
    const ocs = graph.nodes.get(`default:${KIND_OUTPUT_COLOR_SPACE}`)!.params as OutputColorSpaceParams;
    expect(ocs.gammaType).toBe(1); // Adobe RGB → power 2.2
    expect(ocs.matrix[0]).toBeCloseTo(0.7152);
  });

  it('paramsByNodeFromAdjustments emits HDR params keyed on raw16 chain', () => {
    const source = raw16Source({ geometry: baseGeometry });
    const m = paramsByNodeFromAdjustments({}, source);
    expect(m.has(`default:${KIND_WHITE_BALANCE_RAW}`)).toBe(true);
    expect(m.has(`default:${KIND_WHITE_BALANCE}`)).toBe(false);
    expect(m.has(`default:${KIND_COLOR_MATRIX}`)).toBe(true);
    expect(m.has(`default:${KIND_OUTPUT_COLOR_SPACE}`)).toBe(true);
    expect(m.has(`default:${KIND_TONE}`)).toBe(true);
  });

  it('routes RAW temperature and tint into multiplicative raw WB gains', () => {
    const source = raw16Source({ geometry: baseGeometry });
    const m = paramsByNodeFromAdjustments({ temperature: 100, tint: 0 }, source);
    const wbRaw = m.get(`default:${KIND_WHITE_BALANCE_RAW}`) as WhiteBalanceRawParams;

    expect(wbRaw.wb[0]).toBeGreaterThan(1);
    expect(wbRaw.wb[1]).toBe(1);
    expect(wbRaw.wb[2]).toBeLessThan(1);
    expect(wbRaw.wb[0] * wbRaw.wb[1] * wbRaw.wb[2]).toBeCloseTo(1);
  });

  it('raw16 plan compiles into an HDR (RGBA16F) segment + an RGBA8 output segment', async () => {
    const registry = new NodeRegistry();
    registerBuiltinConverts(registry);
    registerBuiltinSources(registry);
    registerBuiltinPassKinds(registry);
    const { graph } = buildDefaultGraph(
      {},
      raw16Source({
        geometry: baseGeometry,
        calibration: { asShotNeutral: [2, 1, 1.5], colorMatrix: [
          1.5, -0.3, -0.2,
          -0.1, 1.4, -0.3,
          0,    -0.2, 1.2,
        ] },
      }),
    );
    const plan = await new GraphCompiler(registry).compile(graph);
    // Phase 2 raw16 layout: raw16 (linear) → WBraw → ColorMatrix → linear
    // block → OutputColorSpace (→ gamma) → gamma block. Compiler runs the
    // first segment as RGBA16F (linear math), flips to RGBA8 for the
    // post-OCS gamma tail. No degamma-convert at the head (source is
    // already linear).
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    expect(plan.segments[0].fboFormat).toBe('rgba16f');
    // Last segment is the gamma-encoded tail.
    expect(plan.segments[plan.segments.length - 1].fboFormat).toBe('rgba8');
    // Identity SDR adjustments still get skipped in the HDR chain.
    expect(plan.identitySkips.has(`default:${KIND_TONE}`)).toBe(true);
    // Calibration with non-identity WB stays in the active set.
    expect(plan.identitySkips.has(`default:${KIND_WHITE_BALANCE_RAW}`)).toBe(false);
  });
});

// ─── Layered graph (D1 — Phase 1.C foundation) ─────────────────────

describe('buildLayeredGraph', () => {
  it('emits one base chain + per-layer chain + sequential compositors', () => {
    const { graph, sourceNodeId } = buildLayeredGraph(
      { exposure: 30 },
      [
        { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' },
        { id: 'L2', adjustments: { vibrance: 40 }, opacity: 0.5, blendMode: 'multiply' },
      ],
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    expect(sourceNodeId).toBe(`default:${KIND_IMAGE_BITMAP_SOURCE}`);

    // Phase 2: chain = 11 linear + 1 OCS + 5 gamma = 17 steps per chain.
    // 1 source + 17 base + 2 × 17 layer + 2 compositors = 54 nodes.
    expect(graph.nodes.size).toBe(1 + 17 + 2 * 17 + 2);

    // Output is the last compositor.
    expect(graph.output).toBe('comp:L2');

    // Each compositor receives two incoming edges (in + layer).
    const toL1 = graph.edges.filter((e) => e.to.node === 'comp:L1');
    expect(toL1).toHaveLength(2);
    expect(new Set(toL1.map((e) => e.to.port))).toEqual(new Set(['in', 'layer']));

    const toL2 = graph.edges.filter((e) => e.to.node === 'comp:L2');
    expect(toL2).toHaveLength(2);
    // L2's primary input is the previous compositor (sequential chain).
    const inEdge = toL2.find((e) => e.to.port === 'in')!;
    expect(inEdge.from.node).toBe('comp:L1');
  });

  it('layeredParamsByNode produces matching keys for every chain node + compositor', () => {
    const layers = [
      { id: 'sky', adjustments: { exposure: 10 }, opacity: 0.7, blendMode: 'normal' as const },
    ];
    const source = { kind: 'imageBitmap' as const, geometry: baseGeometry };
    const { graph } = buildLayeredGraph({}, layers, source);
    const params = layeredParamsByNode({}, layers, source);

    // Every chain node in the graph (except the source) must have a params entry.
    for (const [id, node] of graph.nodes) {
      if (id === `default:${KIND_IMAGE_BITMAP_SOURCE}`) continue;
      expect(params.has(id), `missing params for ${id} (kind ${node.kind})`).toBe(true);
    }

    // Compositor params reflect the layer settings.
    expect(params.get('comp:sky')).toEqual({ opacity: 0.7, blendMode: 'normal', useMask: false });
  });

  it('merges layer deltas additively onto base for numeric fields', () => {
    const { graph } = buildLayeredGraph(
      { exposure: 20 },
      [{ id: 'a', adjustments: { exposure: 10 }, opacity: 1, blendMode: 'normal' }],
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    // Base chain tone uses 0.2 (20/100). Layer chain merges base + delta → 30/100 = 0.3.
    const baseTone = graph.nodes.get(`default:${KIND_TONE}`)!.params as { exposure: number };
    expect(baseTone.exposure).toBeCloseTo(0.2);
    const layerTone = graph.nodes.get(`layer:a:default:${KIND_TONE}`)!.params as { exposure: number };
    expect(layerTone.exposure).toBeCloseTo(0.3);
  });

  it('compositor compiles and lands in its own segment (multi-input boundary)', async () => {
    const registry = new NodeRegistry();
    registerBuiltinConverts(registry);
    registerBuiltinSources(registry);
    registerBuiltinPassKinds(registry);
    // Compositor registration is required for layered graphs.
    const { registerBuiltinCompositors } = await import('./compositorKinds');
    registerBuiltinCompositors(registry);

    const { graph } = buildLayeredGraph(
      {},
      [{ id: 'a', adjustments: {}, opacity: 1, blendMode: 'normal' }],
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const plan = await new GraphCompiler(registry).compile(graph);
    expect(plan.augmentedNodes.has('comp:a')).toBe(true);
    expect(plan.augmentedNodes.get('comp:a')?.kind).toBe(KIND_COMPOSITE);
    // Both incoming edges survive into augmentedEdges.
    const toComp = plan.augmentedEdges.filter((e) => e.to.node === 'comp:a');
    expect(toComp).toHaveLength(2);
  });

  it('promotes both layer color branches through their gamma boundaries for a 16F terminal', async () => {
    const registry = new NodeRegistry();
    registerAllBuiltins(registry);
    const source = raw16Source({ geometry: baseGeometry });
    const { graph } = buildLayeredGraph(
      {},
      [{ id: 'a', adjustments: {}, opacity: 0.5, blendMode: 'normal' }],
      source,
    );
    const compiler = new GraphCompiler(registry);
    const preview = await compiler.compile(graph);
    const highDepth = await compiler.compile(graph, { terminalFormat: 'rgba16f' });
    const colorBoundaryIds = [
      `default:${KIND_OUTPUT_COLOR_SPACE}`,
      `default:${KIND_TRANSFORM}`,
      `layer:a:default:${KIND_OUTPUT_COLOR_SPACE}`,
      `layer:a:default:${KIND_TRANSFORM}`,
      'comp:a',
    ];

    expect(colorBoundaryIds.some((id) => preview.perNodeFbo.get(id)?.format === 'rgba8')).toBe(true);
    for (const id of colorBoundaryIds) {
      expect(highDepth.perNodeFbo.get(id)?.format, id).toBe('rgba16f');
    }
  });
});

describe('the camera profile\'s base stage', () => {
  const geometry = { width: 1200, height: 800, pixelRatio: 1 };
  const profiled = (exposure: number) => raw16Source({ geometry, baseAdjustments: { exposure } });
  const layers: BuilderLayer[] = [{ id: 'a', adjustments: { exposure: 10 }, opacity: 1, blendMode: 'normal' }];
  const exposureOf = (params: Map<string, unknown>, id: string) => (params.get(id) as { exposure: number }).exposure;

  it('names the base steps of a profiled RAW chain, each ahead of its user step', () => {
    const source = profiled(30);
    const steps = chainStepsForSource(source);
    expect(steps.map((s) => s.kind)).toEqual(chainKindsForSource(source));
    expect(steps.filter((s) => s.stage === 'base').map((s) => s.kind)).toEqual([
      KIND_TONE, KIND_TONE_CURVE, KIND_LEVELS, KIND_HSL, KIND_COLOR_GRADING, KIND_CLARITY,
      KIND_TEXTURE, KIND_DENOISE, KIND_SHARPEN,
    ]);
    steps.forEach((step, index) => {
      if (step.stage !== 'base') return;
      expect(index).toBeLessThan(steps.findIndex((s) => s.kind === step.kind && s.stage === 'user'));
    });
    expect(chainStepsForSource(raw16Source()).every((s) => s.stage === 'user')).toBe(true);
  });

  it('reads the stage out of a node id, layer prefix or not', () => {
    expect(stageOfNodeId(`base:${KIND_TONE}`)).toBe('base');
    expect(stageOfNodeId(`layer:L1:base:${KIND_TONE}`)).toBe('base');
    // A projected layer is named after its compositor, colon included.
    expect(stageOfNodeId(`layer:comp:L1:base:${KIND_TONE}`)).toBe('base');
    expect(stageOfNodeId(`default:${KIND_TONE}`)).toBe('user');
    expect(stageOfNodeId(`layer:base:default:${KIND_TONE}`)).toBe('user');
    expect(stageOfNodeId('user:tone')).toBe('user');
    const { graph } = buildLayeredGraph({}, layers, profiled(30));
    const baseIds = [...graph.nodes.keys()].filter((id) => stageOfNodeId(id) === 'base');
    expect(baseIds).toHaveLength(2 * 9);
  });

  it('carries the profile in base:* and the edits in default:*, as the graph was built', () => {
    const source = profiled(30);
    const params = paramsByNodeFromAdjustments({ exposure: 20 }, source);
    expect(exposureOf(params, `base:${KIND_TONE}`)).toBeCloseTo(0.3);
    expect(exposureOf(params, `default:${KIND_TONE}`)).toBeCloseTo(0.2);
    for (const [id, node] of buildDefaultGraph({ exposure: 20 }, source).graph.nodes) {
      if (node.kind !== KIND_RAW16_SOURCE) expect(params.get(id), id).toEqual(node.params);
    }

    const layered = layeredParamsByNode({ exposure: 20 }, layers, source);
    expect(exposureOf(layered, `layer:a:base:${KIND_TONE}`)).toBeCloseTo(0.3);
    expect(exposureOf(layered, `layer:a:default:${KIND_TONE}`)).toBeCloseTo(0.3);
    for (const [id, node] of buildLayeredGraph({ exposure: 20 }, layers, source).graph.nodes) {
      if (node.kind !== KIND_RAW16_SOURCE) expect(layered.get(id), id).toEqual(node.params);
    }
  });

  it('lets two RAWs share one plan and still hands each its own profile (the F010 probe)', () => {
    const a = profiled(30);
    const b = profiled(-40);
    for (const build of [
      (s: typeof a) => buildDefaultGraph({}, s).graph,
      (s: typeof a) => buildLayeredGraph({}, layers, s).graph,
    ]) {
      expect(build(a).id).toBe(build(b).id);
      expect(build(a).metadata.revision).toBe(build(b).metadata.revision);
    }
    expect(exposureOf(paramsByNodeFromAdjustments({}, a), `base:${KIND_TONE}`)).toBe(0.3);
    expect(exposureOf(paramsByNodeFromAdjustments({}, b), `base:${KIND_TONE}`)).toBe(-0.4);
    expect(exposureOf(layeredParamsByNode({}, layers, b), `layer:a:base:${KIND_TONE}`)).toBe(-0.4);
  });

  it('keeps graphs with and without a profile or lens profile in separate cache slots', () => {
    const lensProfile = { k1: 0.021, k2: -0.004, k3: 0, v1: -0.12, v2: 0.03, v3: 0, caR: 0.0007, caB: -0.0005 };
    const sources = [
      raw16Source({ geometry }),
      profiled(30),
      raw16Source({ geometry, lensProfile }),
      // A space override in the profile is compiled into the base node.
      raw16Source({ geometry, baseAdjustments: { exposure: 30, toneCurveSpace: 'gamma' } }),
    ];
    expect(new Set(sources.map((s) => buildLayeredGraph({}, layers, s).graph.id)).size).toBe(4);
    expect(new Set(sources.map((s) => buildDefaultGraph({}, s).graph.id)).size).toBe(4);
  });

  it('gives a layer with its own colour-space override its own cache slot', async () => {
    const registry = new NodeRegistry();
    registerAllBuiltins(registry);
    const source = raw16Source({ geometry });
    const plain = buildLayeredGraph(
      {}, [{ id: 'a', adjustments: { exposure: 20 }, opacity: 1, blendMode: 'normal' }], source,
    );
    const overridden = buildLayeredGraph(
      {}, [{ id: 'a', adjustments: { exposure: 20, toneCurveSpace: 'gamma' }, opacity: 1, blendMode: 'normal' }], source,
    );

    // The override is a compile-time fact: the plan gains the converts that
    // bracket the layer's tone curve.
    const plainPlan = await new GraphCompiler(registry).compile(plain.graph);
    const overriddenPlan = await new GraphCompiler(registry).compile(overridden.graph);
    expect(overriddenPlan.topologicalOrder.length).toBeGreaterThan(plainPlan.topologicalOrder.length);

    // Plans are cached on graph.id alone, so toggling the override has to
    // change the id - otherwise the second render reuses the first one's plan.
    expect(overridden.graph.id).not.toBe(plain.graph.id);
  });
});

describe('merging a layer onto the base: fields without a zero point', () => {
  // The review's probe for F012: a preset is the whole Adjustments object of
  // the photo it was saved from, defaults included, on a RAW whose lens has a
  // measured profile.
  const lensProfile = { k1: 0.021, k2: -0.004, k3: 0, v1: -0.12, v2: 0.03, v3: 0, caR: 0.0007, caB: -0.0005 };
  const source = raw16Source({ geometry: baseGeometry, lensProfile });
  const full = adjustmentsToBuilderAdjustments(defaultAdjustments);
  const base = { ...full, exposure: 20 };

  const branchParams = (layers: BuilderLayer[], layerId: string, kind: string) => {
    const id = `layer:${layerId}:default:${kind}`;
    const inGraph = buildLayeredGraph(base, layers, source).graph.nodes.get(id)!.params;
    // The graph and the per-render map are two spellings of one merge.
    expect(layeredParamsByNode(base, layers, source).get(id)).toEqual(inGraph);
    return inGraph as Record<string, unknown>;
  };

  it('renders a preset layer from full adjustments with its own values, not the doubled ones', () => {
    const preset: BuilderLayer = {
      id: 'p', opacity: 1, blendMode: 'normal', presetSyncId: 'sync-p',
      adjustments: { ...full, exposure: 10, grain: 33, vignette: -12 },
    };
    expect(branchParams([preset], 'p', KIND_LENS_CORRECTION)).toMatchObject({ enabled: true, strength: 1 });
    expect(branchParams([preset], 'p', KIND_EFFECTS)).toMatchObject({
      vignetteFeather: 0.5, grainSize: 25, grain: 0.33, vignette: -0.12,
    });
    expect(branchParams([preset], 'p', KIND_DENOISE)).toMatchObject({ detail: 0.5 });
    // Numbers with a zero point still add on top of the base.
    expect((branchParams([preset], 'p', KIND_TONE) as { exposure: number }).exposure).toBeCloseTo(0.3);
  });

  it('keeps an ordinary layer\'s denoise detail inside the schema range', () => {
    const layer: BuilderLayer = { id: 'a', opacity: 1, blendMode: 'normal', adjustments: { denoiseDetail: 70 } };
    expect(branchParams([layer], 'a', KIND_DENOISE)).toMatchObject({ detail: 0.7 });
  });

  it('names every builder number whose default is not zero', () => {
    const defaults = defaultAdjustments as unknown as Record<string, unknown>;
    const offZero = Object.keys(defaults).filter((key) =>
      typeof defaults[key] === 'number' && defaults[key] !== 0
      && key in adjustmentsToBuilderAdjustments({ [key]: defaults[key] }));
    expect(offZero.sort()).toEqual([...ABSOLUTE_FIELDS].sort());
  });
});

describe('node params are shader-scale, not editor-scale', () => {
  // The graph editor's inspectors edit these params directly. They run on the
  // editor's ±100 scale, the params on the shader's, and for a while the
  // Tone/WhiteBalance/HSL/Clarity/Texture inspectors wrote the raw ±100 number
  // straight through — a 100× overshoot that made graph-mode sliders unusable.
  // Pinning the contract here keeps the conversion honest on both sides.
  it('divides the editor scale by 100 for the params that shaders read as fractions', () => {
    const { graph } = buildDefaultGraph(
      { exposure: 20, contrast: -30, temperature: 40, vibrance: 50, clarity: 60, texture: 70 },
      { kind: 'imageBitmap', geometry: baseGeometry },
    );
    const params = (kind: string) => graph.nodes.get(`default:${kind}`)?.params as Record<string, number>;
    expect(params(KIND_TONE).exposure).toBeCloseTo(0.2);
    expect(params(KIND_TONE).contrast).toBeCloseTo(-0.3);
    expect(params(KIND_WHITE_BALANCE).temperature).toBeCloseTo(0.4);
    expect(params(KIND_HSL).vibrance).toBeCloseTo(0.5);
    expect(params(KIND_CLARITY).clarity).toBeCloseTo(0.6);
    expect(params(KIND_TEXTURE).amount).toBeCloseTo(0.7);
  });
});

describe('syncDefaultNodeParams', () => {
  it('refreshes the builder-owned nodes from the current adjustments', () => {
    const source = { kind: 'imageBitmap' as const, geometry: baseGeometry };
    const { graph } = buildDefaultGraph({ exposure: 10 }, source);
    const synced = syncDefaultNodeParams(graph, { exposure: 40 }, source);
    expect((synced.nodes.get(`default:${KIND_TONE}`)?.params as { exposure: number }).exposure)
      .toBeCloseTo(0.4);
    // Plan caches key on (id, revision), so a stale revision would keep
    // serving the plan compiled from the old params.
    expect(synced.metadata.revision).toBe(graph.metadata.revision + 1);
    // The input graph is untouched — callers hold it in React state.
    expect((graph.nodes.get(`default:${KIND_TONE}`)?.params as { exposure: number }).exposure)
      .toBeCloseTo(0.1);
  });

  it('leaves topology and user-added nodes alone', () => {
    const source = { kind: 'imageBitmap' as const, geometry: baseGeometry };
    const { graph } = buildDefaultGraph({}, source);
    const withCustom = {
      ...graph,
      nodes: new Map(graph.nodes).set('user:tone', {
        id: 'user:tone', kind: KIND_TONE, params: { exposure: 0.9 },
      }),
    };
    const synced = syncDefaultNodeParams(withCustom, { exposure: 40 }, source);
    expect((synced.nodes.get('user:tone')?.params as { exposure: number }).exposure).toBe(0.9);
    expect(synced.edges).toBe(withCustom.edges);
    expect(synced.nodes.size).toBe(withCustom.nodes.size);
  });
});

describe('syncLayeredNodeParams', () => {
  const source = { kind: 'imageBitmap' as const, geometry: baseGeometry };
  const layers = [
    { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' as const },
    { id: 'L2', adjustments: { vibrance: 40 }, opacity: 0.5, blendMode: 'multiply' as const },
  ];

  it('refreshes base chain, branch chains and compositor params', () => {
    const { graph } = buildLayeredGraph({ exposure: 10 }, layers, source);
    const synced = syncLayeredNodeParams(
      graph,
      { exposure: 40 },
      [
        { ...layers[0], opacity: 0.25 },
        { ...layers[1], blendMode: 'screen' as const },
      ],
      source,
    );
    const exposureOf = (id: string) => (synced.nodes.get(id)?.params as { exposure: number }).exposure;
    expect(exposureOf(`default:${KIND_TONE}`)).toBeCloseTo(0.4);
    // The branches inherit the base exposure — a classic slider edit has to
    // reach them too, or the branch renders the value it was born with.
    expect(exposureOf(`layer:L1:default:${KIND_TONE}`)).toBeCloseTo(0.4);
    expect(exposureOf(`layer:L2:default:${KIND_TONE}`)).toBeCloseTo(0.4);
    expect(synced.nodes.get('comp:L1')?.params)
      .toEqual({ opacity: 0.25, blendMode: 'normal', useMask: false });
    expect(synced.nodes.get('comp:L2')?.params)
      .toEqual({ opacity: 0.5, blendMode: 'screen', useMask: false });
    expect(synced.metadata.revision).toBe(graph.metadata.revision + 1);
  });

  it('leaves the input graph and user-added nodes alone', () => {
    const { graph } = buildLayeredGraph({ exposure: 10 }, layers, source);
    const withCustom = {
      ...graph,
      nodes: new Map(graph.nodes).set('user:tone', {
        id: 'user:tone', kind: KIND_TONE, params: { exposure: 0.9 },
      }),
    };
    const synced = syncLayeredNodeParams(withCustom, { exposure: 40 }, layers, source);
    expect((synced.nodes.get('user:tone')?.params as { exposure: number }).exposure).toBe(0.9);
    expect(synced.edges).toBe(withCustom.edges);
    expect(synced.nodes.size).toBe(withCustom.nodes.size);
    expect((graph.nodes.get(`layer:L1:default:${KIND_TONE}`)?.params as { exposure: number }).exposure)
      .toBeCloseTo(0.1);
  });
});

describe('graphMatchesLayers', () => {
  const source = { kind: 'imageBitmap' as const, geometry: baseGeometry };
  const layers = [
    { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' as const },
    { id: 'L2', adjustments: { vibrance: 40 }, opacity: 0.5, blendMode: 'multiply' as const, useMask: true },
  ];

  it('matches the graph it was built from', () => {
    const { graph } = buildLayeredGraph({}, layers, source);
    expect(graphMatchesLayers(graph, layers)).toBe(true);
  });

  it('rejects an added, removed, reordered or re-masked layer', () => {
    const { graph } = buildLayeredGraph({}, layers, source);
    expect(graphMatchesLayers(graph, [layers[0]])).toBe(false);
    expect(graphMatchesLayers(graph, [
      ...layers,
      { id: 'L3', adjustments: {}, opacity: 1, blendMode: 'normal' as const },
    ])).toBe(false);
    expect(graphMatchesLayers(graph, [layers[1], layers[0]])).toBe(false);
    expect(graphMatchesLayers(graph, [layers[0], { ...layers[1], useMask: false }])).toBe(false);
  });

  it('a flat graph never matches a non-empty stack', () => {
    const { graph } = buildDefaultGraph({}, source);
    expect(graphMatchesLayers(graph, layers)).toBe(false);
    expect(graphMatchesLayers(graph, [])).toBe(true);
  });

  it('tolerates a node the user inserted between two compositors', () => {
    const { graph } = buildLayeredGraph({}, layers, source);
    // comp:L1 → user:tone → comp:L2.in, replacing the direct edge. Order still
    // holds, so the graph stays syncable instead of being thrown away.
    const nodes = new Map(graph.nodes).set('user:tone', {
      id: 'user:tone', kind: KIND_TONE, params: {},
    });
    const edges = graph.edges
      .filter((e) => !(e.from.node === 'comp:L1' && e.to.node === 'comp:L2'))
      .concat([
        { id: 'e:comp:L1→user:tone', from: { node: 'comp:L1', port: 'out' }, to: { node: 'user:tone', port: 'in' } },
        { id: 'e:user:tone→comp:L2', from: { node: 'user:tone', port: 'out' }, to: { node: 'comp:L2', port: 'in' } },
      ]);
    expect(graphMatchesLayers({ ...graph, nodes, edges }, layers)).toBe(true);
  });

  it('a masked layer needs its mask source node', () => {
    const { graph } = buildLayeredGraph({}, layers, source);
    expect(graph.nodes.has(maskNodeIdForLayer('L2'))).toBe(true);
    const nodes = new Map(graph.nodes);
    nodes.delete(maskNodeIdForLayer('L2'));
    expect(graphMatchesLayers({ ...graph, nodes }, layers)).toBe(false);
  });
});
