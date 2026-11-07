export async function replayCommand(_args: string[]) {
  process.stderr.write(
    'ecp shadow-replay: replays need real workers, which this build refuses. The mechanism is tested with fakes.\n',
  );
  process.exitCode = 3;
}
