// A much, much smarter person than me solved this problem, and their code represents the bulk of the work here:
// http://stackoverflow.com/questions/2270910/how-to-convert-sequence-of-numbers-in-an-array-to-range-of-numbers

function getHexValue(num: number): string {
  return num.toString(16).toUpperCase();
}

const getUnicodeRanges = (codePoints: Iterable<number>): string => {
  const ranges: string[] = [];
  // Dedupe — duplicate codepoints would otherwise emit `U+41,U+41-42`.
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);

  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;

    while (i + 1 < sorted.length && sorted[i + 1] - sorted[i] === 1) {
      end = sorted[i + 1];
      i++;
    }

    ranges.push(
      start === end
        ? `U+${getHexValue(start)}`
        : `U+${getHexValue(start)}-${getHexValue(end)}`
    );
  }

  return ranges.toString();
};

export = getUnicodeRanges;
