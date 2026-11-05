export async function isolationCommand(_args: string[]) {
  process.stderr.write('ecp isolation-prove: arrives at M9I\n');
  process.exitCode = 3;
}
