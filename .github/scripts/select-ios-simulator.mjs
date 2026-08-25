import { pathToFileURL } from "node:url";

const IOS_RUNTIME_PATTERN =
  /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/u;
const IPHONE_DEVICE_TYPE_MARKER = ".SimDeviceType.iPhone-";
const CONCRETE_UDID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STABLE_DEVICE_STATES = new Set(["Booted", "Shutdown"]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRuntimeVersionsDescending(left, right) {
  const componentCount = Math.max(left.length, right.length);

  for (let index = 0; index < componentCount; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

export function selectIosSimulator(inventory) {
  if (
    inventory === null ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    inventory.devices === null ||
    typeof inventory.devices !== "object" ||
    Array.isArray(inventory.devices)
  ) {
    throw new TypeError("simctl inventory must contain a devices object");
  }

  const candidates = [];

  for (const [runtimeIdentifier, devices] of Object.entries(inventory.devices)) {
    const runtimeMatch = IOS_RUNTIME_PATTERN.exec(runtimeIdentifier);
    if (runtimeMatch === null || !Array.isArray(devices)) continue;

    const runtimeVersion = runtimeMatch[1].split("-").map(Number);

    for (const device of devices) {
      if (
        device === null ||
        typeof device !== "object" ||
        device.isAvailable !== true ||
        typeof device.deviceTypeIdentifier !== "string" ||
        !device.deviceTypeIdentifier.includes(IPHONE_DEVICE_TYPE_MARKER) ||
        typeof device.name !== "string" ||
        device.name.length === 0 ||
        typeof device.state !== "string" ||
        !STABLE_DEVICE_STATES.has(device.state) ||
        typeof device.udid !== "string" ||
        !CONCRETE_UDID_PATTERN.test(device.udid)
      ) {
        continue;
      }

      candidates.push({
        name: device.name,
        runtimeIdentifier,
        runtimeVersion,
        state: device.state,
        udid: device.udid.toUpperCase(),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      compareRuntimeVersionsDescending(left.runtimeVersion, right.runtimeVersion) ||
      compareText(left.name, right.name) ||
      compareText(left.udid, right.udid),
  );

  const selected = candidates[0];
  if (selected === undefined) return null;

  return {
    name: selected.name,
    runtimeIdentifier: selected.runtimeIdentifier,
    state: selected.state,
    udid: selected.udid,
  };
}

async function main() {
  try {
    process.stdin.setEncoding("utf8");
    let source = "";
    for await (const chunk of process.stdin) source += chunk;

    const inventory = JSON.parse(source);
    const selected = selectIosSimulator(inventory);

    if (selected === null) {
      throw new Error("simctl reported no concrete available iPhone simulator");
    }

    process.stdout.write(`${selected.udid}\t${selected.state}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Unable to select an iOS simulator: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
