// A much, much smarter person than me solved this problem, and their code represents the bulk of the work here:
// http://stackoverflow.com/questions/2270910/how-to-convert-sequence-of-numbers-in-an-array-to-range-of-numbers

function getHexValue(num: number): string {
  return num.toString(16).toUpperCase();
}

const getUnicodeRanges = (codePoints: Iterable<number>): string => {
  const ranges: string[] = [];
  let start: number, end: number;

  const sorted = [...codePoints].sort((a, b) => a - b);

  for (let i = 0; i < sorted.length; i++) {
    start = sorted[i];
    end = start;

    while (sorted[i + 1] - sorted[i] === 1) {
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
