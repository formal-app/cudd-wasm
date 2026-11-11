// Types for cudd.mjs, the Emscripten module build.sh links: CUDD's C API, as
// numbers. Pointers are byte offsets into the module's memory; a DdNode
// pointer's lowest bit marks a complemented edge.

export interface CuddModule {
  HEAP32: Int32Array;
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(s: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(s: string): number;

  _malloc(bytes: number): number;
  _free(ptr: number): void;

  _cw_manager_new(nvars: number): number;
  _cw_dot(dd: number, n: number, f: number, inames: number, onames: number): number;

  _Cudd_Quit(dd: number): void;
  _Cudd_Ref(f: number): void;
  _Cudd_RecursiveDeref(dd: number, f: number): void;
  _Cudd_CheckZeroRef(dd: number): number;
  _Cudd_ReadOne(dd: number): number;
  _Cudd_ReadLogicZero(dd: number): number;
  _Cudd_ReadZero(dd: number): number;
  _Cudd_bddIthVar(dd: number, i: number): number;
  _Cudd_bddAnd(dd: number, f: number, g: number): number;
  _Cudd_bddOr(dd: number, f: number, g: number): number;
  _Cudd_bddXor(dd: number, f: number, g: number): number;
  _Cudd_bddXnor(dd: number, f: number, g: number): number;
  _Cudd_bddNand(dd: number, f: number, g: number): number;
  _Cudd_bddNor(dd: number, f: number, g: number): number;
  _Cudd_bddIte(dd: number, f: number, g: number, h: number): number;
  _Cudd_bddLeq(dd: number, f: number, g: number): number;
  _Cudd_bddExistAbstract(dd: number, f: number, cube: number): number;
  _Cudd_bddUnivAbstract(dd: number, f: number, cube: number): number;
  _Cudd_bddAndAbstract(dd: number, f: number, g: number, cube: number): number;
  _Cudd_bddSwapVariables(dd: number, f: number, x: number, y: number, n: number): number;
  _Cudd_Cofactor(dd: number, f: number, g: number): number;
  _Cudd_bddCompose(dd: number, f: number, g: number, v: number): number;
  _Cudd_IndicesToCube(dd: number, array: number, n: number): number;
  _Cudd_bddPickOneCube(dd: number, f: number, out: number): number;
  _Cudd_Eval(dd: number, f: number, inputs: number): number;
  _Cudd_SupportIndices(dd: number, f: number, indices: number): number;
  _Cudd_CountMinterm(dd: number, f: number, nvars: number): number;
  _Cudd_DagSize(f: number): number;
  _Cudd_SharingSize(nodes: number, n: number): number;
  _Cudd_BddToAdd(dd: number, f: number): number;
  _Cudd_T(f: number): number;
  _Cudd_E(f: number): number;
  _Cudd_V(f: number): number;
  _Cudd_IsConstant(f: number): number;
  _Cudd_NodeReadIndex(f: number): number;
  _Cudd_ReadPerm(dd: number, i: number): number;
  _Cudd_ReadInvPerm(dd: number, level: number): number;
  _Cudd_ReadSize(dd: number): number;
  _Cudd_ShuffleHeap(dd: number, permutation: number): number;
  _Cudd_ReduceHeap(dd: number, method: number, minsize: number): number;
  _Cudd_Srandom(dd: number, seed: number): void;
  _Cudd_SetTimeLimit(dd: number, ms: number): number;
  _Cudd_UnsetTimeLimit(dd: number): void;
  _Cudd_ResetStartTime(dd: number): void;
  _Cudd_ReadElapsedTime(dd: number): number;
  _Cudd_ReadReorderingTime(dd: number): number;
  _Cudd_SetMaxLive(dd: number, n: number): void;
  _Cudd_SetMaxMemory(dd: number, bytes: number): number;
  _Cudd_ReadErrorCode(dd: number): number;
  _Cudd_ClearErrorCode(dd: number): void;
  _Cudd_ReadNodeCount(dd: number): number;
  _Cudd_ReadPeakLiveNodeCount(dd: number): number;
  _Cudd_ReadCacheLookUps(dd: number): number;
  _Cudd_ReadCacheHits(dd: number): number;
  _Cudd_ReadGarbageCollections(dd: number): number;
  _Cudd_ReadReorderings(dd: number): number;
  _Cudd_ReadSwapSteps(dd: number): number;
  _Cudd_ReadMemoryInUse(dd: number): number;
}

export default function createModule(options?: {
  locateFile?: (path: string, prefix: string) => string;
}): Promise<CuddModule>;
