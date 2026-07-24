**Example input**

Topic: Why independent hotels lose margin to OTAs
Target audience: Independent hotel owners and revenue managers
Keyword hints: direct booking, OTA commission, room matrix
Constraints: Keep statistics generic (no fabricated named studies)
Key facts: OTA commissions run 15-30% per booking; a live room matrix reduces double-booking risk; direct-booked guests return more often.
Competitor gap notes: Most OTA commission explainers describe the problem but stop short of naming a concrete technical fix like a live room matrix.
Planned angle: OTA commission is a recurring tax on margin; a direct booking engine with a live room matrix is the fix.
Planned titles: "The Real Cost of OTA Commission on Independent Hotel Margin", "Why Direct Booking Beats OTAs for Independent Hotels", "How a Live Room Matrix Fixes Independent Hotels' Double-Booking Problem"
Outline: H1 "The Real Cost of OTA Commission on Independent Hotel Margin"; H2 "The Commission Problem, in Real Numbers"; H2 "Why Manual Multi-Channel Inventory Creates Double-Bookings"; H2 "What a Direct Booking Engine With a Live Room Matrix Does"; H2 "The Retention Upside of Booking Direct"

**Example output**

```json
{
  "seoTitle": "The Real Cost of OTA Commission on Independent Hotel Margin",
  "seoTitleAlternatives": [
    "The Real Cost of OTA Commission on Independent Hotel Margin",
    "Why Direct Booking Beats OTAs for Independent Hotels",
    "How a Live Room Matrix Fixes Independent Hotels' Double-Booking Problem"
  ],
  "metaTitle": "The Real Cost of OTA Commission for Independent Hotels",
  "metaDescription": "See how OTA commission reduces independent hotel margin and how a direct booking engine with live inventory can protect it.",
  "primaryKeyword": "OTA commission for independent hotels",
  "primaryKeywordConfirmation": "Confirmed as the primary keyword because it matches both the planner's chosen angle and genuine commercial-investigation search intent.",
  "secondaryKeywordStrategy": [
    { "keyword": "direct booking engine", "role": "supporting", "placement": "H2 covering the direct-booking mechanism", "rationale": "Names the concrete fix the article recommends." },
    { "keyword": "hotel room matrix", "role": "semantic", "placement": "Body copy near the inventory-risk section", "rationale": "Reinforces the technical mechanism without repeating the primary keyword." }
  ],
  "semanticKeywordClusters": [
    { "topic": "OTA commission cost", "keywords": ["OTA commission rate", "booking commission fees"], "intent": "Informational with commercial investigation" },
    { "topic": "direct booking technology", "keywords": ["hotel booking engine", "live room matrix"], "intent": "Commercial investigation" }
  ],
  "nlpEntities": [
    { "name": "OTA", "type": "Industry term", "relevance": "high" },
    { "name": "room matrix", "type": "Product mechanism", "relevance": "medium" }
  ],
  "longTailKeywordOpportunities": [
    { "keyword": "how much commission do hotels pay OTAs", "intent": "Informational", "rationale": "Directly matches a question users ask that the outline already answers." }
  ],
  "searchIntentValidation": {
    "validatedIntent": "Informational with commercial investigation",
    "matchesResearchIntent": true,
    "rationale": "Matches the research module's stated intent; the outline both explains the cost and evaluates a specific fix."
  },
  "featuredSnippetOpportunities": [
    { "query": "how much commission do OTAs charge hotels", "format": "paragraph", "recommendedAnswerAngle": "Open the commission section with a direct one-sentence answer before expanding." }
  ],
  "peopleAlsoAskCoverage": [
    { "question": "How much commission do OTAs charge hotels?", "coverageStatus": "covered", "placement": "The Commission Problem, in Real Numbers" },
    { "question": "How can an independent hotel increase direct bookings?", "coverageStatus": "recommended", "placement": "The Retention Upside of Booking Direct" }
  ],
  "faqOptimizationRecommendations": [
    { "question": "What percentage commission do OTAs charge hotels?", "answerGuidance": "State the general 15-30% range and note it varies by market and contract before pointing readers to their own agreement.", "includeInFaqSchema": true }
  ],
  "headingOptimizationGuidance": [
    { "heading": "The Real Cost of OTA Commission on Independent Hotel Margin", "level": 1, "recommendation": "Keep the primary keyword near the start of the H1.", "keywordPlacement": "Primary keyword in the first half of the H1." },
    { "heading": "What a Direct Booking Engine With a Live Room Matrix Does", "level": 2, "recommendation": "Lead with the supporting keyword since this section explains the recommended fix.", "keywordPlacement": "Supporting keyword in the heading itself." }
  ],
  "urlSlugValidation": {
    "slug": "ota-commission-independent-hotels-direct-booking",
    "isValid": true,
    "rationale": "Lowercase, hyphenated, and contains the primary keyword without unnecessary stop words."
  },
  "canonicalRecommendation": {
    "recommendation": "Use the final published URL as its own canonical.",
    "rationale": "This is a new, single-published-location article with no syndicated or duplicate variant."
  },
  "internalLinkingStrategy": {
    "anchorThemes": ["hotel direct booking technology", "hotel revenue management fundamentals"],
    "implementationGuidance": "Link to existing posts covering direct booking technology or revenue management once the Draft Writer confirms which published posts exist; do not fabricate specific target posts here."
  },
  "externalAuthorityRecommendations": [
    { "sourceType": "Recognized hospitality industry research publication", "recommendation": "Cite general commission-range figures to a credible hospitality research source rather than an invented statistic.", "rationale": "Supports the commission claim without overstating precision the research module did not supply." }
  ],
  "suggestedSchemaTypes": [
    { "type": "Article", "rationale": "Standard structured data for a long-form informational article." },
    { "type": "FAQ", "rationale": "The FAQ recommendations above are strong candidates for FAQPage markup." },
    { "type": "Breadcrumb", "rationale": "Supports site navigation context in search results." }
  ],
  "localBusinessApplicability": {
    "applicable": false,
    "rationale": "This article targets hotel operators broadly rather than promoting one physical local business location."
  },
  "imageAltTextGuidance": {
    "patterns": ["Describe the specific hotel-operations scene shown, e.g. a front-desk booking screen", "Include the primary keyword only when it genuinely describes the image"],
    "avoid": ["Generic alt text like \"hotel image\" or \"photo\"", "Keyword-stuffed alt text that does not describe the image"],
    "requiredContext": "Alt text should reflect the direct-booking or inventory-management scene actually depicted."
  },
  "imageFilenameGuidance": {
    "pattern": "lowercase-hyphenated-descriptive-filename.jpg",
    "examples": ["direct-booking-engine-dashboard.jpg", "hotel-room-matrix-inventory-view.jpg"]
  },
  "eeatRecommendations": [
    { "recommendation": "Attribute commission-range claims to a named category of industry source rather than presenting them as the author's own data.", "evidenceType": "Cited industry benchmark" }
  ],
  "readabilityTargets": {
    "targetReadingLevel": "Intermediate",
    "targetSentenceLengthWords": 18,
    "targetParagraphLengthSentences": 4,
    "guidance": "Keep sentences direct and avoid stacking multiple qualifiers; this audience wants the operational takeaway quickly."
  },
  "contentGapRecommendations": [
    { "gap": "Competitors rarely name a concrete technical fix.", "opportunity": "Give the room-matrix mechanism its own detailed section rather than a passing mention.", "priority": "high" }
  ],
  "keywordPlacementRecommendations": [
    { "location": "First 100 words", "keyword": "OTA commission for independent hotels", "recommendation": "Introduce the primary keyword naturally in the opening paragraph." },
    { "location": "Conclusion", "keyword": "direct booking engine", "recommendation": "Reinforce the supporting keyword when restating the recommended fix." }
  ],
  "seoScore": 82
}
```
