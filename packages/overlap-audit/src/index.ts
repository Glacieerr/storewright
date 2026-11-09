/**
 * @storewright/overlap-audit — count where vehicle footprints overlap in a simulated day, and fail when it gets worse.
 * 车辆重叠审计：统计一天里车身矩形重叠的「车对 × 秒」，变多了就失败。
 *
 * Typical use: sample all bodies every few seconds, feed them to an {@link OverlapAuditor} with an area classifier and an
 * ignore hook, then compare the tally with limits ({@link checkLimits}) and exit non-zero if an area got worse.
 * Or export trajectories as JSON from any engine and run the CLI ({@link auditTrajectories}).
 */
export { quadsOverlap, obbsOverlap, shapesOverlap, obbToQuad, obbFromHeading, quadAabb, obbAabb, shapeAabb, quadCenter, quadHeading, hitched, isObb, type Quad, type OBB, type AABB, type Shape, type OverlapOptions } from './geom';
export { forEachCandidatePair, candidatePairs } from './grid';
export { OverlapTally, OverlapAuditor, StillTracker, quadKey, defaultPair, type Body, type Counts, type Overlap, type AuditorOptions } from './audit';
export { checkLimits, formatReport, type Limits, type LimitRow, type LimitReport } from './limits';
export { bodiesAt, trajectorySpan, validateTrajectories, inPolygon, type TrajectoryFile, type TrajVehicle, type SnapBody, type Frame, type TrajData } from './trajectory';
export { auditTrajectories, type TrajectoryAuditOptions, type TrajectoryAuditResult } from './run';
