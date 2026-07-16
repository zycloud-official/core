import { randomInt } from "node:crypto";

// Free-tier accounts get a name like this instead of picking one (a future
// paid tier may let members choose their own — not built yet). Kept short,
// boring, and lowercase-alphanumeric so it's always a valid CapRover app name
// / subdomain segment without further sanitization.
const ADJECTIVES = [
  "quiet", "brave", "calm", "swift", "bright", "gentle", "bold", "cool",
  "eager", "fresh", "kind", "lively", "mellow", "nimble", "plain", "quick",
  "rapid", "sharp", "smooth", "solid", "steady", "sunny", "tidy", "vivid",
  "warm", "wild", "young", "amber", "coral", "cosmic",
];

const NOUNS = [
  "otter", "falcon", "harbor", "meadow", "willow", "canyon", "comet", "ember",
  "forest", "glacier", "island", "jasper", "lagoon", "maple", "orchid", "pebble",
  "quartz", "ridge", "river", "summit", "tundra", "valley", "willowherb", "cedar",
  "birch", "dune", "fjord", "grove", "haven", "meridian",
];

function pad4(n) {
  return String(n).padStart(4, "0");
}

// e.g. "brave-otter-4821"
export function generateAppName() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const suffix = pad4(randomInt(10000));
  return `${adjective}-${noun}-${suffix}`;
}
