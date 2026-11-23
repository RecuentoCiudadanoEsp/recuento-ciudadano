# Genera un ZIP sintético con el mismo diseño de registro que el de Interior, para probar el conversor.
import random, zipfile, io
random.seed(7)
mun = {"08":["187","019","279"],"28":["079","007"],"41":["091"]}
partidos = [("000001","PARTIDO A","Partido A de ejemplo"),("000002","PARTIDO B","Partido B de ejemplo"),("000003","PARTIDO C","Partido C de ejemplo"),("000004","PARTIDO D","Partido D de ejemplo")]
l03=[f"02202307{c}{s:<50}{d:<150}" for c,s,d in partidos]
l09=[]; l10=[]
for prov,ms in mun.items():
  for m in ms:
    for dist in ["01","02"]:
      for sec in range(1,4):
        for mesa in "AB":
          pre=f"022023071{'09':>2}{prov}{m}{dist}{sec:04d}{mesa}"
          censo=random.randint(450,900)
          l09.append(pre+f"{censo:07d}"+"0"*70+"S")
          for c,_,_ in partidos: l10.append(pre+c+f"{random.randint(10,200):07d}")
  l09.append(f"022023071{'09':>2}{prov}99999{'0001'}U"+f"{1000:07d}"+"0"*70+"S")
b=io.BytesIO(); z=zipfile.ZipFile(b,"w")
z.writestr("03022307.DAT","\n".join(l03).encode("latin-1")); z.writestr("09022307.DAT","\n".join(l09).encode("latin-1")); z.writestr("10022307.DAT","\n".join(l10).encode("latin-1")); z.close()
open("test/prueba_MESA.zip","wb").write(b.getvalue()); print(len(l09),"mesas")
