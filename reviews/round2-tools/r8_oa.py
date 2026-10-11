import sys
S='/tmp/claude-0/-home-claude/962f84b0-1380-5f53-8c9f-f3c861af4b17/scratchpad/oa/'
p1=open(S+'part1.yaml').read(); p2=open(S+'part2.yaml').read()
def rep(s,a,b,n=1):
    c=s.count(a)
    if c!=n: print('MISSING',c,a[:100]); sys.exit(1)
    return s.replace(a,b)
n=p1.count("version: rules-fts-2.2"); p1=p1.replace("version: rules-fts-2.2","version: rules-fts-2.3")
n2=p1.count("'rules-fts-2.2'"); p1=p1.replace("'rules-fts-2.2'","'rules-fts-2.3'")
print('example versions replaced',n,n2)
p2=rep(p2,"currently rules-fts-2.2 (2.1: synonym exactness and the imitation-jewellery qualifier; 2.2: quantity tokens need an allow-listed unit, and brand words from a barcode lookup never count towards exactness).'","currently rules-fts-2.3 (2.1: synonym exactness and the imitation-jewellery qualifier; 2.2: quantity tokens need an allow-listed unit, and brand words from a barcode lookup never count towards exactness; 2.3: an accessory word such as stand, case or charger that follows a candidate''s evidence caps that candidate at 0.45 (low) with a review hint, and packaging words such as box or hamper keep the contents'' candidates with a review hint).'")
p1=rep(p1,"fusion, `classifier.version` `rules-fts-2.2`, architecture.md §5.4).","fusion, `classifier.version` `rules-fts-2.3`, architecture.md §5.4).")
p2=rep(p2,"""                notification: { type: string }
            - type: 'null'
        end_date:""","""                notification: { type: string }
                citation_note: { type: [string, 'null'], description: 'Round 8: the target rule''s citation note, so the checker sees the source caveat (for example a secondary-source transcription) before approving.' }
            - type: 'null'
        end_date:""")
p1=rep(p1,"""        from 7113 to 7117 and lower other Chapter 71 evidence; otherwise""","""        from 7113 to 7117 and lower other Chapter 71 evidence. An accessory word that
        follows a candidate's evidence ("mobile phone stand", "tv wall mount") caps that
        candidate at 0.45 with a review hint unless the word is its own evidence ("phone
        charger" keeps 8504), and packaging words ("gift box", "hamper") keep the contents'
        candidates with a review hint (`rules-fts-2.3`). Otherwise""")
open(S+'part1.yaml','w').write(p1); open(S+'part2.yaml','w').write(p2); print('r8 ok')
