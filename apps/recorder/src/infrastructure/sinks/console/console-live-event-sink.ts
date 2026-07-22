import type {
  LiveDiscoveryResult,
  LiveEvent,
  LiveSession,
} from "../../../domain/live";
import type { LiveEventSink } from "../../../ports/live-event-sink";

export class ConsoleLiveEventSink implements LiveEventSink {
  deliver(event: LiveEvent): Promise<void> {
    const label = `${event.target.name} (${event.target.id})`;
    if (event.kind === "error") {
      console.error(
        `${event.checkedAt.toISOString()} [${label}] ERROR ${event.errorKind}: ${event.message}`,
      );
      return Promise.resolve();
    }

    const prefix = `${event.result.checkedAt.toISOString()} [${label}] ${event.kind.toUpperCase()}`;
    if (event.result.state === "live" && event.result.session !== null) {
      console.log(
        `${prefix} LIVE${formatSession(event.result.session)}${formatAddress(event.result)}`,
      );
    } else {
      console.log(`${prefix} OFFLINE`);
    }
    return Promise.resolve();
  }
}

function formatSession(session: LiveSession): string {
  return [
    session.roomId === undefined ? "" : ` room_id=${session.roomId}`,
    session.sourceLink === undefined
      ? ""
      : ` source_link=${session.sourceLink}`,
  ].join("");
}

function formatAddress(event: LiveDiscoveryResult): string {
  const resolution = event.addressResolution;
  if (resolution === null) {
    return "";
  }
  return resolution.status === "resolved"
    ? ` address=${resolution.address}`
    : ` address=unavailable:${resolution.reason}`;
}
