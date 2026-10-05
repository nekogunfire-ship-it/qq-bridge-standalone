"""Build highlights that follow skeleton paths by cumulative arc length."""
import sys
import numpy as np
from PIL import Image, ImageDraw


def skeleton(mask):
    a = np.pad(mask.astype(np.uint8), 1)
    for _ in range(100):
        changed = False
        for phase in (0, 1):
            p = [a[:-2,1:-1], a[:-2,2:], a[1:-1,2:], a[2:,2:],
                 a[2:,1:-1], a[2:,:-2], a[1:-1,:-2], a[:-2,:-2]]
            count = sum(p)
            turns = sum(((p[i]==0)&(p[(i+1)%8]==1)).astype(np.uint8) for i in range(8))
            clear = ((p[0]*p[2]*p[4]==0)&(p[2]*p[4]*p[6]==0)) if phase==0 else ((p[0]*p[2]*p[6]==0)&(p[0]*p[4]*p[6]==0))
            remove = (a[1:-1,1:-1]==1)&(count>=2)&(count<=6)&(turns==1)&clear
            changed |= bool(remove.any())
            a[1:-1,1:-1][remove] = 0
        if not changed: break
    return a[1:-1,1:-1].astype(bool)


def trace(mask):
    points = {tuple(p) for p in np.argwhere(mask)}
    graph = {}
    for y,x in sorted(points):
        graph[y,x] = [(y+dy,x+dx) for dy,dx in ((-1,0),(0,1),(1,0),(0,-1),(-1,-1),(-1,1),(1,1),(1,-1))
                      if (y+dy,x+dx) in points and not (dy and dx and ((y+dy,x) in points or (y,x+dx) in points))]
    visited, paths = set(), []
    for start in [p for p in graph if len(graph[p])!=2]+list(graph):
        for nxt in graph[start]:
            if frozenset((start,nxt)) in visited: continue
            line, previous, current = [start], start, nxt
            while True:
                visited.add(frozenset((previous,current)))
                line.append(current)
                options = [q for q in graph[current] if frozenset((current,q)) not in visited]
                if len(graph[current])!=2 or not options: break
                previous,current = current,options[0]
            xy = np.array([(x,y) for y,x in line], dtype=float)
            distance = np.r_[0,np.cumsum(np.linalg.norm(np.diff(xy,axis=0),axis=1))]
            if distance[-1]>=18: paths.append((xy,distance))
    return paths


def main(source, output):
    im = Image.open(source).convert('RGBA')
    im.thumbnail((520,880),Image.Resampling.LANCZOS)
    a = np.asarray(im).astype(float)
    core = (a[:,:,:3].min(axis=2)>125)&(a[:,:,:3].max(axis=2)>215)&(a[:,:,3]>100)
    paths = trace(skeleton(core))
    assert paths, 'No continuous strokes found'
    palette = [(85,238,255),(116,162,255),(206,133,255),(255,152,226)]
    frames = []
    frame_count = 144
    for f in range(frame_count):
        frame = Image.new('RGBA',im.size)
        draw = ImageDraw.Draw(frame)
        for i,(xy,s) in enumerate(paths):
            length = s[-1]
            tail = min(20,length*.3)
            head = ((f/frame_count+i*.61803398875)%1)*(length+tail)
            colour = palette[i%4]
            for part in range(10):
                low,high = max(0,head-tail+tail*part/10),min(length,head-tail+tail*(part+1)/10)
                if high<=low: continue
                distances = np.linspace(low,high,max(2,int(high-low)+2))
                segment = list(zip(np.interp(distances,s,xy[:,0]),np.interp(distances,s,xy[:,1])))
                strength = int(40+210*part/9)
                draw.line(segment,fill=(*colour,strength//5),width=4)
                draw.line(segment,fill=(*colour,strength),width=1)
        frames.append(frame)
    frames[0].save(output,save_all=True,append_images=frames[1:],duration=[33,33,34]*48,loop=0,format='WEBP',lossless=True,method=3)
    print(f'{len(paths)} traced paths; {frame_count} frames at 30fps; motion follows cumulative path length')


if __name__=='__main__': main(*sys.argv[1:])
