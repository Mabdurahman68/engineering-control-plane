export async function evalCommand(_args: string[]) {
  process.stderr.write('ecp eval: arrives at M10\n');
  process.exitCode = 3;
}
