interface AssetLike {
  type?: string;
  isLoaded?: boolean;
  text: string;
  // assetgraph populates parseTree on CSS assets — kept loose so this
  // shim can be passed to consumers (fontFeatureHelpers) that walk it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseTree?: any;
}

interface RelationLike {
  type: string;
  to: AssetLike;
  media?: string;
  condition?: string;
  conditionalComments?: ReadonlyArray<unknown>; // eslint-disable-line no-restricted-syntax -- shape unused, only length is read
}

interface AssetGraphLike {
  // assetgraph's query DSL accepts arbitrary nested shapes ($in/$or/etc.)
  // eslint-disable-next-line no-restricted-syntax
  findRelations(query: Record<string, unknown>): RelationLike[];
}

interface StylesheetWithPredicates {
  asset: AssetLike;
  text: string;
  predicates: Record<string, boolean>;
}

function gatherStylesheetsWithPredicates(
  assetGraph: AssetGraphLike,
  htmlAsset: AssetLike,
  relationIndex?: Map<AssetLike, RelationLike[]> | null
): StylesheetWithPredicates[] {
  const visiting = new Set<AssetLike>();
  const incomingMedia: string[] = [];
  const conditionalCommentConditionStack: string[] = [];
  const result: StylesheetWithPredicates[] = [];
  (function traverse(
    asset: AssetLike,
    isWithinNotIeConditionalComment: boolean,
    isWithinNoscript: boolean
  ): void {
    if (visiting.has(asset)) {
      return;
    } else if (!asset.isLoaded) {
      return;
    }
    visiting.add(asset);
    // Use pre-built index if available, otherwise fall back to findRelations
    const relations = relationIndex
      ? relationIndex.get(asset) || []
      : assetGraph.findRelations({
          from: asset,
          type: {
            $in: [
              'HtmlStyle',
              'SvgStyle',
              'CssImport',
              'HtmlConditionalComment',
              'HtmlNoscript',
            ],
          },
        });
    for (const relation of relations) {
      if (relation.type === 'HtmlNoscript') {
        traverse(relation.to, isWithinNotIeConditionalComment, true);
      } else if (relation.type === 'HtmlConditionalComment') {
        conditionalCommentConditionStack.push(relation.condition ?? '');
        traverse(
          relation.to,
          isWithinNotIeConditionalComment ||
            (relation.conditionalComments?.length ?? 0) > 0,
          isWithinNoscript
        );
        conditionalCommentConditionStack.pop();
      } else {
        const media = relation.media;
        if (media) {
          incomingMedia.push(media);
        }
        traverse(
          relation.to,
          isWithinNotIeConditionalComment ||
            (relation.conditionalComments?.length ?? 0) > 0,
          isWithinNoscript
        );
        if (media) {
          incomingMedia.pop();
        }
      }
    }
    visiting.delete(asset);
    if (asset.type === 'Css') {
      const predicates: Record<string, boolean> = {};
      for (const incomingMedium of incomingMedia) {
        predicates[`mediaQuery:${incomingMedium}`] = true;
      }
      for (const conditionalCommentCondition of conditionalCommentConditionStack) {
        predicates[`conditionalComment:${conditionalCommentCondition}`] = true;
      }
      if (isWithinNoscript) {
        predicates.script = false;
      }
      if (isWithinNotIeConditionalComment) {
        predicates['conditionalComment:IE'] = false;
      }
      result.push({
        asset,
        text: asset.text,
        predicates,
      });
    }
  })(htmlAsset, false, false);

  return result;
}

export = gatherStylesheetsWithPredicates;
