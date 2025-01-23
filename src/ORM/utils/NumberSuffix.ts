
export class NumberSuffix {

  to(value: number): string {

    const suffixes = ['', 'k', 'M', 'G', 'T', 'P', 'E'];

    if (value == null || value < 0) {
      return '0';
    }

    let power = Math.floor(Math.log10(value) / 3);
    if (power < 0) {
      power = 0;
    }
    const scaledValue = value / Math.pow(1000, power);
    const suffix = suffixes[power];

    return scaledValue.toFixed(2) + suffix;
  }
}