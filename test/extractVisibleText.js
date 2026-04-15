const expect = require('unexpected');
const extractVisibleText = require('../lib/extractVisibleText');
const { INVISIBLE_ELEMENTS } = require('../lib/extractVisibleText');

describe('extractVisibleText', function () {
  it('should extract plain text content', function () {
    const result = extractVisibleText('<p>Hello, world!</p>');
    expect(result, 'to contain', 'Hello, world!');
  });

  // <head> is only valid as a child of <html> (parser ignores it in body),
  // <embed> is a void element (cannot contain text children).
  const SKIP_GENERIC_TEST = new Set(['head', 'embed']);
  for (const element of INVISIBLE_ELEMENTS) {
    if (SKIP_GENERIC_TEST.has(element)) continue;
    it(`should strip <${element}> elements and their contents`, function () {
      const result = extractVisibleText(
        `<p>visible</p><${element}>hidden content</${element}>`
      );
      expect(result, 'to contain', 'visible');
      expect(result, 'not to contain', 'hidden content');
    });
  }

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
    // <title> is inside <head>, which is not visible page content
    // (browser tab titles use system fonts, not web fonts)
    expect(result, 'not to contain', 'Page Title');
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

  it('should handle multiple sibling script elements', function () {
    const result = extractVisibleText(
      '<script>hidden_a</script>between<script>hidden_b</script>'
    );
    expect(result, 'to contain', 'between');
    expect(result, 'not to contain', 'hidden_a');
    expect(result, 'not to contain', 'hidden_b');
  });

  it('should not extract value from hidden inputs', function () {
    const result = extractVisibleText('<input type="hidden" value="secret">');
    expect(result, 'not to contain', 'secret');
  });

  it('should handle attributes with HTML entities', function () {
    const result = extractVisibleText('<img alt="Tom &amp; Jerry">');
    expect(result, 'to contain', 'Tom & Jerry');
  });

  it('should handle unquoted attributes', function () {
    const result = extractVisibleText('<img alt=hello>');
    expect(result, 'to contain', 'hello');
  });

  it('should not extract data- attributes that look like extractable attrs', function () {
    // parse5 matches exact attribute names, so data-alt is correctly ignored.
    const result = extractVisibleText(
      '<div data-alt="extra-text">content</div>'
    );
    expect(result, 'to contain', 'content');
    expect(result, 'not to contain', 'extra-text');
  });
});
