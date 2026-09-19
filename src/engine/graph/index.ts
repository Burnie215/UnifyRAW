export * from './types';
export { readColorSpaceOverride } from './types';
export { NodeRegistry, nodeRegistry } from './NodeRegistry';
export { GraphCompiler, CompileError, type CompileOptions } from './GraphCompiler';
export {
  registerBuiltinConverts,
  KIND_CONVERT_LIN_TO_GAMMA,
  KIND_CONVERT_GAMMA_TO_LIN,
  KIND_TAP,
} from './builtins';
export { registerBuiltinPreviewKind, KIND_PREVIEW, type PreviewParams } from './previewKind';
export { ProgramCache, ProgramCompileError, DEFAULT_VERTEX_SHADER } from './ProgramCache';
export { FboPool, type PoolFbo, type SegmentPool } from './FboPool';
export { PipelineExecutor, ExecuteError, type ExecuteResult } from './PipelineExecutor';
export {
  registerBuiltinSources,
  KIND_IMAGE_BITMAP_SOURCE,
  KIND_RAW16_SOURCE,
  KIND_RASTERIZED_MASK_SOURCE,
  type Raw16SourceData,
} from './sources';
export {
  registerBuiltinCompositors,
  KIND_COMPOSITE,
  KIND_AB_SWAP,
  KIND_DIFFERENCE,
  KIND_SIDE_BY_SIDE,
  BLEND_MODE_NAMES,
  type BlendMode as CompositorBlendMode,
  type CompositeParams,
  type AbSwapParams,
  type DifferenceParams,
  type SideBySideParams,
} from './compositorKinds';
export {
  registerBuiltinMaskKinds,
  KIND_RANGE_MASK,
  KIND_EDGE_MASK,
  KIND_MASK_COMBINATOR,
  type RangeMaskParams,
  type RangeMaskType,
  type EdgeMaskParams,
  type MaskCombinatorParams,
  type MaskCombinatorOp,
} from './maskKinds';
export {
  registerBuiltinLutKinds,
  KIND_CUSTOM_LUT,
  MAX_INLINE_LUT_SIZE,
  MIN_LUT_SAMPLES,
  lutSampleCount,
  parseCubeFile,
  type CustomLutParams,
} from './lutKinds';
export {
  registerBuiltinEncoderKinds,
  KIND_MULTI_OUTPUT_ENCODER,
  type MultiOutputEncoderParams,
  type MultiOutputEncoderTarget,
  type EncoderFormat,
  type EncoderColorSpace,
} from './encoderKinds';
export {
  registerBuiltinPassKinds,
  BUILTIN_PASS_KIND_ORDER,
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
  KIND_CROP,
  KIND_WHITE_BALANCE_RAW,
  KIND_COLOR_MATRIX,
  KIND_OUTPUT_COLOR_SPACE,
  IDENTITY_LEVELS_CHANNEL,
  IDENTITY_BW_MIX,
  IDENTITY_CURVE,
  IDENTITY_GRADING_ZONE,
  IDENTITY_HSL_CHANNELS,
  IDENTITY_RAW_WB,
  IDENTITY_COLOR_MATRIX_3X3,
  type ToneParams,
  type WhiteBalanceParams,
  type ToneCurveParams,
  type CurvePoint,
  type HslParams,
  type HslDetailParams,
  type HslChannel,
  type HslChannels,
  type HslDetailViewSelected,
  type HslDetailSkinTone,
  type CustomHslParams,
  type CustomHslSector,
  type LevelsParams,
  type LevelsChannel,
  type BwParams,
  type BwMix,
  type ColorGradingParams,
  type ColorGradingZone,
  type ClarityParams,
  type TextureParams,
  type DenoiseParams,
  type SharpenParams,
  type EffectsParams,
  type TransformParams,
  type CropParams,
  type WhiteBalanceRawParams,
  type ColorMatrixParams,
  type OutputColorSpaceParams,
  type LensCorrectionParams,
  KIND_RETOUCH,
  MAX_RETOUCH_SPOTS,
  type RetouchParams,
  type RetouchSpot,
} from './passKinds';
export {
  buildDefaultGraph,
  buildLayeredGraph,
  adjustmentNodeId,
  maskNodeIdForLayer,
  graphMatchesLayers,
} from './DefaultGraphBuilder';
export { previewSubgraph, subgraphBefore, pruneToOutput } from './subgraph';
export { graphContentKey, graphContentHash } from './graphContentKey';
export { autoLayout, LAYOUT_METRICS } from './autoLayout';
export {
  buildDocumentGraph,
  buildAdjustmentsGraph,
  preCurveStopNodeFor,
  isGraphLed,
  needsDocumentGraph,
  builderLayersForDocument,
  builderBaseForDocument,
  maskLayersForDocument,
  type DocumentGraph,
  type DocumentMaskLayer,
} from './documentGraph';
export {
  documentAfterGraphEdit,
  documentAfterGraphChange,
  documentAfterReturnToClassic,
  withStoredLayout,
  type GraphEditResult,
} from './graphPersistence';
export {
  layeredParamsByNode,
  adjustmentsToBuilderAdjustments,
  paramsByNodeFromAdjustments,
  chainKindsForSource,
  syncDefaultNodeParams,
  syncLayeredNodeParams,
  withDocumentRetouch,
  spliceRetouch,
  retouchNodeId,
  RETOUCH_NODE_ID,
  withDocumentCrop,
  spliceCrop,
  cropFromGraph,
  DOCUMENT_CROP_NODE_ID,
  graphSpaceSignature,
  type BuilderAdjustments,
  type BuilderSourceSpec,
  type BuilderImageBitmapSource,
  type BuilderRaw16Source,
  type BuilderRawCalibration,
  type BuilderLayer,
  type DefaultGraphBuildResult,
} from './DefaultGraphBuilder';
export {
  PipelineService,
  type RenderSource,
} from './PipelineService';
export {
  WorkerPipelineService,
  type WorkerRenderSource,
} from './WorkerPipelineService';
export type {
  PlanHandle,
  WorkerRequest,
  WorkerResponse,
  WorkerSourcePayload,
} from './workerProtocol';
export {
  getDefaultPipelineService,
  setDefaultPipelineService,
  getMainThreadNodeRegistry,
} from './defaultPipelineService';
export {
  detectWebGLCaps,
  editorIsSupported,
  editorUnsupportedMessage,
  type WebGLCaps,
} from '../webglCaps';
export { serializeGraph, hydrateGraph } from './serialize';

// Projection (step 2): the direction Graph -> Document. Kept behind one
// barrel so the UI never has to know which file a rule lives in.
export {
  blockReasonId,
  BLOCK_REASON_PARAMS,
  type BlockReason,
  type BlockReasonKey,
} from './projection/blockReasons';
export {
  scanGraphShape,
  SHAPE_REASONS,
  type BlockedNode,
  type ScannedChain,
  type ScannedLayer,
  type GraphShape,
  type ShapeScanResult,
} from './projection/shapeScan';
export {
  checkChainRules,
  nodeKindLabel,
  CHAIN_REASONS,
  KINDS_WITHOUT_CLASSIC_EQUIVALENT,
} from './projection/chainRules';
export {
  projectToDocument,
  groupBlockedByNode,
  DOCUMENT_REASONS,
  BUILDER_OWNED_ADJUSTMENT_FIELDS,
  type ProjectToDocumentResult,
  type BlockedNodeGroup,
} from './projection/projectToDocument';
export {
  paramsToAdjustments,
  adjustmentsFromChainParams,
  layerDeltaFromMerged,
  PARAM_REASONS,
  type ProjectedParams,
  type ProjectedLayerParams,
  type ParamsToAdjustmentsResult,
} from './projection/paramsToAdjustments';
