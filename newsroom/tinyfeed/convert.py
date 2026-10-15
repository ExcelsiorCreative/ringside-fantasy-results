import json,sys,re,datetime,xml.etree.ElementTree as ET
from urllib.request import urlopen, Request
from pathlib import Path
root=ET.parse(sys.argv[1]).getroot()
channels=json.loads(Path(sys.argv[2]).read_text())
output=Path(sys.argv[3]); old={}
if output.exists():
 try: old=json.loads(output.read_text())
 except ValueError: pass
items=[]; failed=[]; counts={}; seen=set()
for channel in channels:
 found=[]
 for feed in root.findall('feed'):
  if channel['id'] not in feed.get('source','')+feed.get('channel',''):continue
  for video in feed.findall('video'):
   m=re.search(r'(?:v=|youtu.be/)([a-zA-Z0-9_-]{11})',video.get('href',''))
   if not m:continue
   try: datetime.datetime.fromisoformat(video.get('published','').replace('Z','+00:00'))
   except ValueError:continue
   found.append({'id':m[1],'title':video.findtext('title',''),'published':video.get('published'),'promotion':channel['promotion']})
 # Tinyfeed selects uploads; enrich them with official RSS view counts.
 try:
  request=Request('https://www.youtube.com/feeds/videos.xml?channel_id='+channel['id'],headers={'User-Agent':'PopCircumstance/1.0'})
  with urlopen(request,timeout=15) as response: rss=ET.fromstring(response.read())
  ns={'a':'http://www.w3.org/2005/Atom','yt':'http://www.youtube.com/xml/schemas/2015','m':'http://search.yahoo.com/mrss/'}
  stats={}
  for entry in rss.findall('a:entry',ns):
   stat=entry.find('m:group/m:community/m:statistics',ns)
   if stat is not None and stat.get('views','').isdigit():stats[entry.findtext('yt:videoId',namespaces=ns)]=int(stat.get('views'))
  for video in found:video['views']=stats.get(video['id'])
 except Exception:
  for video in found:video['views']=None
 if not found:
  failed.append(channel['promotion'])
  found=[v for v in old.get('items',[]) if v.get('promotion')==channel['promotion']]
 found.sort(key=lambda v:v['published'],reverse=True);counts[channel['promotion']]=len(found[:15])
 for v in found[:15]:
  if (v['promotion'],v['id']) in seen:continue
  seen.add((v['promotion'],v['id']));items.append(v)
if not items:raise SystemExit('No valid uploads; preserving previous snapshot')
items.sort(key=lambda v:v['published'],reverse=True)
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'generator':'TheBigRoomXXL/tinyfeed v1.5.0','fetchedAt':root.get('checked') or datetime.datetime.now(datetime.timezone.utc).isoformat(),'failed':failed,'items':items},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'counts':counts,'failed':failed}))
