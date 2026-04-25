import postcssValueParser = require('postcss-value-parser');

function* parseFontVariationSettings(
  value: string
): Generator<[string, number], void, void> {
  let state = 'BEFORE_AXIS_NAME';
  let axisName: string | undefined;
  for (const token of postcssValueParser(value).nodes) {
    if (token.type === 'space') {
      continue;
    }
    switch (state) {
      case 'BEFORE_AXIS_NAME': {
        if (token.type !== 'string') {
          return;
        }
        axisName = token.value;
        state = 'AFTER_AXIS_NAME';
        break;
      }
      case 'AFTER_AXIS_NAME': {
        if (token.type === 'word') {
          const axisValue = parseFloat(token.value);
          if (!isNaN(axisValue) && axisName !== undefined) {
            yield [axisName, axisValue];
          }
        }
        state = 'AFTER_AXIS_VALUE';
        break;
      }
      case 'AFTER_AXIS_VALUE': {
        if (token.type !== 'div' || token.value !== ',') {
          return;
        }
        axisName = undefined;
        state = 'BEFORE_AXIS_NAME';
        break;
      }
    }
  }
}

export = parseFontVariationSettings;
