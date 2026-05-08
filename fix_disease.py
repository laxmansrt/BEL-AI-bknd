import re

with open('/Users/laxman/BJS /BelAI_bcknd-main/server.js', 'r') as f:
    code = f.read()

start = code.find('// -- DISEASE DETECTION') if '// -- DISEASE DETECTION' in code else code.find('// ── DISEASE DETECTION')
end_marker = '\n// ── FOOD LABEL'
end = code.find(end_marker)

if start == -1 or end == -1:
    print(f"ERROR: start={start}, end={end}")
    print("Looking for disease block...")
    idx = code.find("app.post('/api/disease'")
    print(f"Found disease route at: {idx}")
    # Try to find from 10 lines before the route
    start = code.rfind('\n//', 0, idx)
    end = code.find(end_marker, idx)
    print(f"Adjusted: start={start}, end={end}")

old = code[start:end]
print(f"Old block length: {len(old)} chars")
print("First 200 chars:", old[:200])

new = r"""// ── DISEASE DETECTION (GEMINI 2.5 FLASH VISION — REAL TIME) ─────────────────────

// Robustly extract JSON even when Gemini wraps it in markdown code fences
function extractDiseaseJSON(txt) {
    if (!txt) return null;
    const stripped = txt.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch(e) {} }
    try { return JSON.parse(stripped); } catch(e) { return null; }
}

app.post('/api/disease', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

        const prompt = 'You are an expert plant pathologist. Analyze this plant image. ' +
            'Output ONLY a raw JSON object (no markdown, no code fences, no extra text). ' +
            'Schema: {"disease_name":"disease or Healthy Plant","scientific_name":"pathogen or N/A",' +
            '"confidence_percent":85,"severity":"Mild|Moderate|Severe|Critical|Healthy",' +
            '"affected_area_percent":20,"cause":"brief cause",' +
            '"symptoms_observed":"what you see in THIS specific image",' +
            '"treatment_steps":["step 1","step 2","step 3"],' +
            '"pesticides":[{"name":"product","dosage":"2g/L","frequency":"every 7 days"}],' +
            '"organic_alternatives":"organic option","prevention_tips":"prevention"}. ' +
            'Base ONLY on what is visible. Healthy plants: severity=Healthy, affected_area_percent=0.';

        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ]
        }];

        const data = await geminiPost({ model: 'gemini-2.5-flash', messages, max_tokens: 900 });
        const txt = data.choices?.[0]?.message?.content || '';
        console.log('[Disease AI]:', txt.slice(0, 200));

        const parsed = extractDiseaseJSON(txt);
        if (parsed && parsed.disease_name) return res.json(parsed);
        if (parsed) return res.json({
            disease_name: parsed.disease || parsed.name || 'Analysis result',
            scientific_name: parsed.scientific_name || 'N/A',
            confidence_percent: parsed.confidence_percent || Math.round((parsed.confidence || 0.8) * 100),
            severity: parsed.severity || 'Moderate',
            affected_area_percent: parsed.affected_area_percent || 20,
            cause: parsed.cause || 'Pathogen infection',
            symptoms_observed: parsed.symptoms_observed || parsed.cure || '',
            treatment_steps: parsed.treatment_steps || (parsed.cure ? [parsed.cure] : ['Consult agronomist']),
            pesticides: parsed.pesticides || [],
            organic_alternatives: parsed.organic_alternatives || 'Neem oil spray 5ml/L weekly',
            prevention_tips: parsed.prevention_tips || 'Maintain plant hygiene',
        });
        res.status(422).json({ error: 'Could not parse AI response', raw: txt.slice(0, 300) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
"""

code = code[:start] + new + code[end:]

with open('/Users/laxman/BJS /BelAI_bcknd-main/server.js', 'w') as f:
    f.write(code)

print(f"Done. Lines: {len(code.splitlines())}")
assert 'extractDiseaseJSON' in code
print("Verified OK")
