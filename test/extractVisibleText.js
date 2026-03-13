const expect = require('unexpected');

// extractVisibleText is not exported, so we test it indirectly
// by requiring the module and using a helper to access it.
// Since it's a private function in subsetFonts.js, we extract it
// for testing by reading the source and evaluating just that function.
const fs = require('fs');
const pathModule = require('path');

// Extract the function from the module source
const moduleSource = fs.readFileSync(
  pathModule.resolve(__dirname, '../lib/subsetFonts.js'),
  'utf8'
);
const funcMatch = moduleSource.match(
  /function extractVisibleText\(html\) \{[\s\S]*?\nfunction /
);

let extractVisibleText;
if (funcMatch) {
  // Extract just the function body (remove trailing 'function ' from next function)
  const funcSource = funcMatch[0].replace(/\nfunction $/, '');
  // eslint-disable-next-line no-eval
  extractVisibleText = eval(`(${funcSource})`);
}

describe('extractVisibleText', function () {
  if (!extractVisibleText) {
    it('should be extractable from subsetFonts.js', function () {
      throw new Error(
        'Could not extract extractVisibleText from subsetFonts.js'
      );
    });
    return;
  }

  it('should extract plain text content', function () {
    const result = extractVisibleText('<p>Hello, world!</p>');
    expect(result, 'to contain', 'Hello, world!');
  });

  it('should strip script elements and their contents', function () {
    const result = extractVisibleText(
      '<p>visible</p><script>var x = "hidden";</script><p>also visible</p>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'to contain', 'also visible');
    expect(result, 'not to contain', 'hidden');
  });

  it('should strip style elements and their contents', function () {
    const result = extractVisibleText(
      '<p>visible</p><style>.foo { color: red; }</style>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'not to contain', 'color');
  });

  it('should strip SVG elements and their contents', function () {
    const result = extractVisibleText(
      '<p>visible</p><svg><text>svg text</text></svg>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'not to contain', 'svg text');
  });

  it('should decode HTML entities', function () {
    const result = extractVisibleText('<p>&amp; &lt; &gt; &quot; &apos;</p>');
    expect(result, 'to contain', '&');
    expect(result, 'to contain', '<');
    expect(result, 'to contain', '>');
    expect(result, 'to contain', '"');
    expect(result, 'to contain', "'");
  });

  it('should decode numeric HTML entities', function () {
    const result = extractVisibleText('<p>&#65; &#x42;</p>');
    expect(result, 'to contain', 'A');
    expect(result, 'to contain', 'B');
  });

  it('should decode &nbsp; entities', function () {
    const result = extractVisibleText('<p>hello&nbsp;world</p>');
    expect(result, 'to contain', 'hello\u00A0world');
  });

  it('should extract alt attributes from images', function () {
    const result = extractVisibleText(
      '<img alt="descriptive text" src="photo.jpg">'
    );
    expect(result, 'to contain', 'descriptive text');
  });

  it('should extract title attributes', function () {
    const result = extractVisibleText(
      '<a title="link tooltip" href="#">click</a>'
    );
    expect(result, 'to contain', 'link tooltip');
    expect(result, 'to contain', 'click');
  });

  it('should extract placeholder attributes', function () {
    const result = extractVisibleText(
      '<input placeholder="Enter name" type="text">'
    );
    expect(result, 'to contain', 'Enter name');
  });

  it('should extract aria-label attributes', function () {
    const result = extractVisibleText(
      '<button aria-label="Close dialog">X</button>'
    );
    expect(result, 'to contain', 'Close dialog');
    expect(result, 'to contain', 'X');
  });

  it('should strip HTML comments', function () {
    const result = extractVisibleText(
      '<p>visible</p><!-- hidden comment --><p>also visible</p>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'not to contain', 'hidden comment');
  });

  it('should handle a full HTML document', function () {
    const result = extractVisibleText(`
      <!DOCTYPE html>
      <html>
      <head><title>Page Title</title><style>body{color:red}</style></head>
      <body>
        <h1>Main Heading</h1>
        <p>Paragraph with <strong>bold</strong> text.</p>
        <script>console.log("hidden");</script>
        <img alt="photo description">
      </body>
      </html>
    `);
    expect(result, 'to contain', 'Page Title');
    expect(result, 'to contain', 'Main Heading');
    expect(result, 'to contain', 'Paragraph with');
    expect(result, 'to contain', 'bold');
    expect(result, 'to contain', 'text.');
    expect(result, 'to contain', 'photo description');
    expect(result, 'not to contain', 'console.log');
    expect(result, 'not to contain', 'color:red');
  });

  it('should handle empty input', function () {
    const result = extractVisibleText('');
    expect(result, 'to be a', 'string');
  });

  it('should handle nested script tags', function () {
    const result = extractVisibleText(
      '<div>before<script type="text/javascript">var s = "<script>nested</script>";</script>after</div>'
    );
    expect(result, 'to contain', 'before');
    expect(result, 'to contain', 'after');
  });
});
