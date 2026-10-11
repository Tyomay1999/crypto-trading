import type { ProjectionReader } from "../projection/reader.js";
import type { ProjectionWriter } from "../projection/writer.js";
import {
  mapDrBundleToP3,
} from "./dr-mapper.js";
import type {
  DrSourceBundle,
} from "./dr-source.js";
import {
  reconcileProjectionBundle,
} from "./reconciler.js";

export interface AggregatorRunSummary {
  readonly signalsSeen: number;
  readonly signalsPublished: number;
  readonly eventsAppended: number;
  readonly snapshotsUpdated: number;
  readonly outcomesWritten: number;
}

export async function runDrProjectionAggregator(
  source: AsyncIterable<DrSourceBundle>,
  reader: ProjectionReader,
  writer: ProjectionWriter,
): Promise<AggregatorRunSummary> {
  let signalsSeen = 0;
  let signalsPublished = 0;
  let eventsAppended = 0;
  let snapshotsUpdated = 0;
  let outcomesWritten = 0;

  for await (const raw of source) {
    const bundle = mapDrBundleToP3(raw);
    const result = await reconcileProjectionBundle(
      bundle,
      reader,
      writer,
    );

    signalsSeen += 1;
    signalsPublished += result.published ? 1 : 0;
    eventsAppended += result.eventsAppended;
    snapshotsUpdated +=
      result.snapshotUpdated ? 1 : 0;
    outcomesWritten +=
      result.outcomeWritten ? 1 : 0;
  }

  return Object.freeze({
    signalsSeen,
    signalsPublished,
    eventsAppended,
    snapshotsUpdated,
    outcomesWritten,
  });
}
