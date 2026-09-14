"""Build a standalone Vietnamese documentation portal; no CDN or private JSON."""
from pathlib import Path
import html
import markdown

root=Path(__file__).resolve().parents[1]
docs=root/'docs'

def box(x,y,w,h,title,lines,fill='#ffffff',stroke='#d7e2dc'):
    out=f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}"/>'
    out+=f'<text x="{x+20}" y="{y+32}" font-size="17" font-weight="700">{html.escape(title)}</text>'
    for i,line in enumerate(lines):out+=f'<text x="{x+20}" y="{y+59+i*22}" font-size="13" fill="#536b60">{html.escape(line)}</text>'
    return out

svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 815" role="img" aria-labelledby="title desc"><title id="title">Kiến trúc ChiDi ERP</title><desc id="desc">React đọc qua API có RLS và ghi qua RPC PostgreSQL; demo tách riêng. Đơn hàng, COD, kế toán và tích hợp là giai đoạn sau.</desc><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#557b68"/></marker></defs><rect width="1200" height="815" fill="#f4f7f2"/><g font-family="Segoe UI,Arial,sans-serif" fill="#203f32">'
svg+='<text x="36" y="48" font-size="28" font-weight="700">ChiDi / kiến trúc để vận hành và mở rộng</text><text x="36" y="78" font-size="14" fill="#617768">Nét liền: V1 đã có mã nguồn. Vùng dưới: lộ trình. Cloud đã cấu hình; migration 002 và nghiệm thu tài khoản thật còn chờ.</text>'
svg+=box(36,112,260,120,'Người dùng & React',['Chủ shop / nhân viên','Form, bảng, báo cáo, bộ lọc','JavaScript + JSX + Vite'])
svg+=box(354,112,310,120,'Supabase Auth + Data API',['Đăng nhập → JWT người dùng','Đọc có RLS theo workspace','Không ghi sổ trực tiếp từ browser'],'#e8f0e7')
svg+=box(730,112,430,120,'RPC có kiểm tra nghiệp vụ',['Kiểm role, dữ liệu và khóa chứng từ','Ghi nguyên tử: chứng từ + ledger + audit','Gọi lại không tạo thêm phát sinh'],'#e8f0e7')
svg+=box(36,286,260,145,'Chạy thử trên máy',['Dữ liệu trình duyệt riêng','Không đồng bộ ngầm lên cloud','Dữ liệu minh họa có nhãn','Không thay bảo mật nhiều người'])
svg+=box(354,286,806,145,'PostgreSQL — nguồn dữ liệu dùng chung',['Danh mục: workspace, thành viên, SKU, NCC, kho, tài khoản tiền','Chứng từ: phiếu nhập / thu chi + legacy ID + provenance','Sổ: stock_movements, cash_movements; có phát sinh đảo','Kiểm soát: audit_events, import_batches, request chống trùng'],'#fff')
svg+='<g stroke="#557b68" stroke-width="2" fill="none" marker-end="url(#arrow)"><path d="M296 172H350"/><path d="M296 135V96H941V108"/><path d="M509 232V282"/><path d="M945 232V282"/><path d="M166 232V282"/></g>'
svg+='<rect x="36" y="481" width="1124" height="282" rx="16" fill="#f5f2e9" stroke="#bfa97b" stroke-dasharray="7 5"/><text x="58" y="517" font-size="18" font-weight="700">PHÁT TRIỂN TIẾP — chưa là chức năng V1 đã nghiệm thu</text>'
svg+=box(58,542,335,116,'Đơn hàng / kho / COD',['Giữ hàng → giao → hoàn','FIFO xuất bán, công nợ, đối soát','Tiền COD không thêm doanh thu'],'#fffcf5','#ddcfb2')
svg+=box(411,542,335,116,'Kế toán quản trị',['Sổ kép, kỳ và khóa kỳ','P&L, số dư đầu, đối chiếu sổ','CRM, lương, tài sản theo nhu cầu'],'#fffcf5','#ddcfb2')
svg+=box(764,542,374,116,'Tích hợp & vận hành',['Edge Function giữ bí mật API','Outbox → worker → đối tác','Storage riêng, backup & restore'],'#fffcf5','#ddcfb2')
svg+='<text x="58" y="699" font-size="14" fill="#756449">Nhập Excel có đối chiếu: nguồn → bản nháp → kiểm chứng → ghi sổ. Không ghi đè workbook.</text><text x="58" y="729" font-size="14" fill="#756449">Vận hành online cần kiểm tra Auth / API thật, nhiều kết nối và khôi phục backup trước dùng làm sổ chính.</text>'
svg+='<text x="36" y="795" font-size="12" fill="#617768">ChiDi Online ERP · thiết kế 10/09/2026 · xem tài liệu kiến trúc để biết đầy đủ phạm vi và nguồn nghiên cứu.</text></g></svg>'
(docs/'architecture.svg').write_text(svg,encoding='utf-8')

pages=[('architecture','Kiến trúc','KIEN_TRUC_ERP_CHIDI.md'),('operations','Bước tiếp V1.1','THIET_LAP_VAN_HANH_V11.md'),('history','Đã thực hiện','CHANGELOG.md'),('setup','Tạo Supabase','SUPABASE_SETUP.md'),('guide','Cách sử dụng','USER_GUIDE.md'),('database','Database','DATABASE_CONTRACT.md'),('prompt','Prompt triển khai','PROMPT_XAY_DUNG_ERP_CHIDI.md'),('checks','Kiểm tra','VERIFICATION.md'),('sources','Nguồn nghiên cứu','RESEARCH_SOURCES.md')]
articles=[]
for key,label,filename in pages:
    source=(docs/filename).read_text(encoding='utf-8')
    body=markdown.markdown(source,extensions=['tables','fenced_code','toc'])
    for dest,label2,file2 in pages:body=body.replace(f'href="{file2}"',f'href="#{dest}" data-page="{dest}"')
    extra='<img class="architecture" src="architecture.svg" alt="Sơ đồ kiến trúc ChiDi ERP"/>' if key=='architecture' else ''
    button='<button class="copy" id="copy-prompt">Sao chép toàn bộ prompt</button>' if key=='prompt' else ''
    articles.append(f'<article id="{key}" data-panel{" hidden" if key!="architecture" else ""}>{button}{extra}{body}<p class="sourcefile"><a href="{filename}">Mở bản Markdown gốc</a></p></article>')
nav=''.join(f'<button data-target="{key}" aria-pressed="{str(key=="architecture").lower()}">{label}</button>' for key,label,file in pages)
prompt=html.escape((docs/'PROMPT_XAY_DUNG_ERP_CHIDI.md').read_text(encoding='utf-8'))
page='''<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChiDi ERP — kiến trúc & hướng dẫn</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6f2;color:#273e32;font:16px/1.8 "Segoe UI",Arial,sans-serif}header{padding:32px 5vw;background:#173e31;color:#fff}header b{font-size:30px;letter-spacing:-1px}header p{margin:3px 0;color:#d7e7d8}nav{padding:13px 5vw;background:white;border-bottom:1px solid #dfe6dd;display:flex;gap:8px;flex-wrap:wrap;position:sticky;top:0;z-index:2}button{font:inherit;cursor:pointer;border:1px solid #d6e2d7;border-radius:7px;padding:8px 13px;background:#fff;color:#254b37}button[aria-pressed=true],button.copy{background:#244f3b;color:white}main{max-width:1200px;margin:30px auto;padding:0 25px}article{background:white;padding:35px 45px;border:1px solid #dce4da;border-radius:12px}h1{font-size:30px;line-height:1.4}h2{margin-top:42px;font-size:24px;line-height:1.5}h3{margin-top:30px}p,li{max-width:1020px}table{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow:auto;margin:22px 0}td,th{border:1px solid #d8e0d6;padding:12px 15px;text-align:left;vertical-align:top}th{background:#edf3e9}pre{background:#edf2eb;padding:18px;overflow:auto;font:13px/1.7 Consolas,monospace;border-radius:8px}code{overflow-wrap:anywhere;font-family:Consolas,monospace;font-size:.9em}a{color:#286b49;text-underline-offset:3px}img.architecture{width:100%;border-radius:10px}.copy{margin-bottom:18px}.sourcefile{border-top:1px solid #dce4da;padding-top:20px;font-size:13px}footer{text-align:center;padding:30px;color:#5d7465}.sr{position:absolute;left:-9999px}button:focus-visible,a:focus-visible{outline:3px solid #ad853b;outline-offset:3px}[hidden]{display:none!important}@media(max-width:650px){body{font-size:15px}header{padding:22px}nav{position:static;padding:12px}main{padding:0 10px;margin:14px auto}article{padding:22px 17px}h1{font-size:25px}h2{font-size:21px}}@media print{header,nav,footer,.copy,.sourcefile{display:none}body,article{background:white}main{max-width:none;margin:0;padding:0}article{border:0;padding:0}h2{break-after:avoid}pre,table,img{break-inside:avoid}}
</style></head><body><header><b>ChiDi / không gian tài liệu ERP</b><p>Kiến trúc, hướng dẫn Supabase và prompt để tiếp tục phát triển · 11/09/2026</p></header><nav aria-label="Tài liệu">'''+nav+'''</nav><main>'''+''.join(articles)+'''</main><textarea id="prompt-source" class="sr" aria-hidden="true" tabindex="-1">'''+prompt+'''</textarea><footer>V1 chạy trên máy; Supabase đã cấu hình; migration 002 và đăng nhập thật còn chờ. Dữ liệu riêng không nằm trong trang tài liệu này.</footer><script>
const select=(id)=>{if(!document.getElementById(id)?.matches('[data-panel]'))id='architecture';document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.id!==id);document.querySelectorAll('[data-target]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.target===id)));};
document.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>{location.hash=b.dataset.target;window.scrollTo(0,0)});document.querySelectorAll('[data-page]').forEach(a=>a.onclick=()=>{select(a.dataset.page);window.scrollTo(0,0)});addEventListener('hashchange',()=>select(location.hash.slice(1)));select(location.hash.slice(1));
document.getElementById('copy-prompt').onclick=async function(){const input=document.getElementById('prompt-source');try{if(navigator.clipboard)await navigator.clipboard.writeText(input.value);else{input.select();if(!document.execCommand('copy'))throw Error();}this.textContent='Đã sao chép prompt';}catch{this.textContent='Mở bản Markdown gốc để sao chép';}};
</script></body></html>'''
(docs/'index.html').write_text(page,encoding='utf-8')
print(f'Built docs/index.html ({len(page):,} characters) and architecture.svg')
