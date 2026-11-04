<p align="center"><img src="assets/everything.png" width="300" alt="Everything"></p>

<h3 align="center">全世界的软件，从零重建，全部开源。</h3>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.es.md">Español</a></p>

<!-- App names, descriptions, and navigation are native text. The Everything logo, app icons, and decorative hero are images. Demo and source links use project metadata where available; missing destinations point to the link-status note. -->

<p align="center"><img src="assets/hero/variants/34-app-wall-intact.png" width="100%" alt="Everything：一面延伸到画面之外的应用截图墙"></p>

Everything 项目致力于从零开始重建全世界的软件，并将其全部开源。从 Office 到 Slack，从 Photoshop 到 AutoCAD，我们正在为所有专有软件打造免费、开源的替代品。本仓库是一个单一代码仓库（monorepo），包含该项目开发的所有应用和工具。


[办公](#办公) · [协作](#协作) · [创意工具](#创意工具) · [工程](#工程) · [效率](#效率) · [财务](#财务) · [商业](#商业) · [开发者工具](#开发者工具) · [游戏](#游戏)

<br>

## 快速开始

需要 Node.js 22.12 或更高版本。

```sh
git clone https://github.com/HeyPuter/everything.git
cd everything/src/[app-name]
npm install
npm run dev
```

<br>

## 办公

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://spreadsheet.puter.com/?lang=zh-Hans"><img src="src/spreadsheet/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://spreadsheet.puter.com/?lang=zh-Hans">Spreadsheet</a></strong></td><td width="420" valign="middle">Microsoft Excel, Google Sheets, Apple Numbers</td><td width="150" valign="middle" nowrap><a href="https://spreadsheet.puter.com/?lang=zh-Hans">试用</a>&nbsp;|&nbsp;<a href="src/spreadsheet/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://documents.puter.com/"><img src="src/documents/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://documents.puter.com/">Documents</a></strong></td><td width="420" valign="middle">Microsoft Word, Google Docs, Apple Pages</td><td width="150" valign="middle" nowrap><a href="https://documents.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/documents/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://presentation.puter.com/"><img src="src/presentation/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://presentation.puter.com/">Presentation</a></strong></td><td width="420" valign="middle">Microsoft PowerPoint, Google Slides, Apple Keynote</td><td width="150" valign="middle" nowrap><a href="https://presentation.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/presentation/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://whiteboard.puter.com/"><img src="src/whiteboard/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://whiteboard.puter.com/">Whiteboard</a></strong></td><td width="420" valign="middle">Miro, Microsoft Whiteboard, FigJam</td><td width="150" valign="middle" nowrap><a href="https://whiteboard.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/whiteboard/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://pdf.puter.com/"><img src="src/pdf/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://pdf.puter.com/">PDF</a></strong></td><td width="420" valign="middle">Adobe Acrobat, PDF Expert</td><td width="150" valign="middle" nowrap><a href="https://pdf.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/pdf/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://notes.puter.com/"><img src="src/notes/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://notes.puter.com/">Notes</a></strong></td><td width="420" valign="middle">Microsoft OneNote, Evernote, Apple Notes</td><td width="150" valign="middle" nowrap><a href="https://notes.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/notes/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://records.puter.com/"><img src="src/records/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://records.puter.com/">Records</a></strong></td><td width="420" valign="middle">Airtable, Microsoft Access, Baserow</td><td width="150" valign="middle" nowrap><a href="https://records.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/records/">源码</a></td></tr>
</table>

<br>

## 协作

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://meetings.puter.com/"><img src="src/meetings/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://meetings.puter.com/">Meetings</a></strong></td><td width="420" valign="middle">Zoom, Google Meet, Microsoft Teams</td><td width="150" valign="middle" nowrap><a href="https://meetings.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/meetings/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://teamchat.puter.com/"><img src="src/teamchat/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://teamchat.puter.com/">Teamchat</a></strong></td><td width="420" valign="middle">Slack, Microsoft Teams, Google Chat</td><td width="150" valign="middle" nowrap><a href="https://teamchat.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/teamchat/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://email.puter.com/"><img src="src/email/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://email.puter.com/">Email</a></strong></td><td width="420" valign="middle">Gmail, Microsoft Outlook, Apple Mail</td><td width="150" valign="middle" nowrap><a href="https://email.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/email/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://contacts.puter.com/"><img src="src/contacts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://contacts.puter.com/">Contacts</a></strong></td><td width="420" valign="middle">Google Contacts, Apple Contacts</td><td width="150" valign="middle" nowrap><a href="https://contacts.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/contacts/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://calendar.puter.com/"><img src="src/calendar/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://calendar.puter.com/">Calendar</a></strong></td><td width="420" valign="middle">Google Calendar, Apple Calendar, Outlook Calendar</td><td width="150" valign="middle" nowrap><a href="https://calendar.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/calendar/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://sign.puter.com/"><img src="src/signatures/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://sign.puter.com/">Signatures</a></strong></td><td width="420" valign="middle">DocuSign, Adobe Acrobat Sign, Dropbox Sign</td><td width="150" valign="middle" nowrap><a href="https://sign.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/signatures/">源码</a></td></tr>
</table>

<br>

## 创意工具

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ps.puter.com/"><img src="src/photo-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ps.puter.com/">Photo Studio</a></strong></td><td width="420" valign="middle">Adobe Photoshop, Pixelmator</td><td width="150" valign="middle" nowrap><a href="https://ps.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/photo-studio/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://vs.puter.com/"><img src="src/video-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://vs.puter.com/">Video Studio</a></strong></td><td width="420" valign="middle">CapCut, Adobe Premiere Pro, Final Cut Pro, DaVinci Resolve</td><td width="150" valign="middle" nowrap><a href="https://vs.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/video-studio/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ves.puter.com/"><img src="src/vector-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ves.puter.com/">Vector Studio</a></strong></td><td width="420" valign="middle">Adobe Illustrator, CorelDRAW, Affinity Designer</td><td width="150" valign="middle" nowrap><a href="https://ves.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/vector-studio/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://as.puter.com/"><img src="src/audio-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://as.puter.com/">Audio Studio</a></strong></td><td width="420" valign="middle">Adobe Audition, Sound Forge</td><td width="150" valign="middle" nowrap><a href="https://as.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/audio-studio/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ms.puter.com/"><img src="src/music-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ms.puter.com/">Music Studio</a></strong></td><td width="420" valign="middle">FL Studio, Ableton Live, Logic Pro</td><td width="150" valign="middle" nowrap><a href="https://ms.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/music-studio/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://3d.puter.com/"><img src="src/3d/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://3d.puter.com/">3D Studio</a></strong></td><td width="420" valign="middle">Autodesk Maya, SketchUp</td><td width="150" valign="middle" nowrap><a href="https://3d.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/3d/">源码</a></td></tr>
</table>

<br>

## 工程

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://cad.puter.com/"><img src="src/cad/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://cad.puter.com/">CAD</a></strong></td><td width="420" valign="middle">AutoCAD, DraftSight, BricsCAD</td><td width="150" valign="middle" nowrap><a href="https://cad.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/cad/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://parametric.puter.com/"><img src="src/parametric/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://parametric.puter.com/">Parametric</a></strong></td><td width="420" valign="middle">SolidWorks, Autodesk Fusion, Autodesk Inventor</td><td width="150" valign="middle" nowrap><a href="https://parametric.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/parametric/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://circuits.puter.com/"><img src="src/circuits/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://circuits.puter.com/">Circuits</a></strong></td><td width="420" valign="middle">Altium Designer, Autodesk Eagle, OrCAD</td><td width="150" valign="middle" nowrap><a href="https://circuits.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/circuits/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://bd.puter.com/"><img src="src/building-design/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://bd.puter.com/">Building Design</a></strong></td><td width="420" valign="middle">Autodesk Revit, ArchiCAD, Vectorworks</td><td width="150" valign="middle" nowrap><a href="https://bd.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/building-design/">源码</a></td></tr>
</table>

<br>

## 效率

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://tasks.puter.com/"><img src="./src/tasks/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://tasks.puter.com/">Tasks</a></strong></td><td width="420" valign="middle">Todoist, Microsoft To Do, TickTick</td><td width="150" valign="middle" nowrap><a href="https://tasks.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/tasks/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://projects.puter.com/"><img src="src/projects/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://projects.puter.com/">Projects</a></strong></td><td width="420" valign="middle">Trello, Asana, monday.com</td><td width="150" valign="middle" nowrap><a href="https://projects.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/projects/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://wiki.puter.com/"><img src="src/wiki/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://wiki.puter.com/">Wiki</a></strong></td><td width="420" valign="middle">Notion, Confluence, Coda</td><td width="150" valign="middle" nowrap><a href="https://wiki.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/wiki/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://tt.puter.com/"><img src="./src/time-tracking/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://tt.puter.com/">Time Tracking</a></strong></td><td width="420" valign="middle">Toggl Track, Harvest, Clockify</td><td width="150" valign="middle" nowrap><a href="https://tt.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/time-tracking/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://survey.puter.com/"><img src="src/survey/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://survey.puter.com/">Surveys</a></strong></td><td width="420" valign="middle">SurveyMonkey, Google Forms, Typeform</td><td width="150" valign="middle" nowrap><a href="https://survey.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/survey/">源码</a></td></tr>
</table>

<br>

## 财务

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://accounting.puter.com/"><img src="src/accounting/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://accounting.puter.com/">Accounting</a></strong></td><td width="420" valign="middle">QuickBooks Online, Xero, Wave Accounting</td><td width="150" valign="middle" nowrap><a href="https://accounting.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/accounting/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://invoicing.puter.com/"><img src="src/invoicing/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://invoicing.puter.com/">Invoicing</a></strong></td><td width="420" valign="middle">FreshBooks, Zoho Invoice, Wave Invoicing</td><td width="150" valign="middle" nowrap><a href="https://invoicing.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/invoicing/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://expenses.puter.com/"><img src="src/expense/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://expenses.puter.com/">Expenses</a></strong></td><td width="420" valign="middle">Expensify, SAP Concur, Zoho Expense</td><td width="150" valign="middle" nowrap><a href="#link-status" title="演示地址尚未提供">试用</a>&nbsp;|&nbsp;<a href="src/expense/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://captable.puter.com/"><img src="src/cap-table/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://captable.puter.com/">Cap Table</a></strong></td><td width="420" valign="middle">Carta, Pulley</td><td width="150" valign="middle" nowrap><a href="https://captable.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/cap-table/">源码</a></td></tr>
</table>

<br>

## 商业

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://crm.puter.com/"><img src="src/crm/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://crm.puter.com/">CRM</a></strong></td><td width="420" valign="middle">Salesforce, HubSpot CRM, Pipedrive</td><td width="150" valign="middle" nowrap><a href="https://crm.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/crm/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://help.puter.com/"><img src="src/help-desk/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://help.puter.com/">Help Desk</a></strong></td><td width="420" valign="middle">Zendesk, Freshdesk, Intercom, Help Scout</td><td width="150" valign="middle" nowrap><a href="https://help.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/help-desk/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://contracts.puter.com/"><img src="src/contracts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://contracts.puter.com/">Contracts</a></strong></td><td width="420" valign="middle">ContractSafe, Juro</td><td width="150" valign="middle" nowrap><a href="https://contracts.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/contracts/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://pos.puter.com/"><img src="src/pos/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://pos.puter.com/">Point of Sale</a></strong></td><td width="420" valign="middle">Square POS, Shopify POS, Lightspeed</td><td width="150" valign="middle" nowrap><a href="https://pos.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/pos/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://inventory.puter.com/"><img src="src/inventory/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://inventory.puter.com/">Inventory</a></strong></td><td width="420" valign="middle">Zoho Inventory, Sortly, inFlow Inventory</td><td width="150" valign="middle" nowrap><a href="https://inventory.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/inventory/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><img src="src/assets/icon-128.png" width="48" height="48" alt="" align="center"> &nbsp; <strong><a href="../equipment/">Assets</a></strong></td><td width="420" valign="middle">Asset Panda, EZOfficeInventory</td><td width="150" valign="middle" nowrap><a href="#link-status" title="演示地址尚未提供">试用</a>&nbsp;|&nbsp;<a href="src/assets/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://hiring.puter.com/"><img src="src/hiring/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://hiring.puter.com/">Hiring</a></strong></td><td width="420" valign="middle">Greenhouse, Lever, Workable</td><td width="150" valign="middle" nowrap><a href="https://hiring.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/hiring/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://shifts.puter.com/"><img src="src/shifts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://shifts.puter.com/">Shifts</a></strong></td><td width="420" valign="middle">Deputy, When I Work, Homebase</td><td width="150" valign="middle" nowrap><a href="https://shifts.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/shifts/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://childcare.puter.com/"><img src="src/childcare/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://childcare.puter.com/">Childcare</a></strong></td><td width="420" valign="middle">brightwheel, Procare, HiMama</td><td width="150" valign="middle" nowrap><a href="https://childcare.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/childcare/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://fieldservice.puter.com/"><img src="src/field-service/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://fieldservice.puter.com/">Field Service</a></strong></td><td width="420" valign="middle">Jobber, Housecall Pro, ServiceTitan</td><td width="150" valign="middle" nowrap><a href="https://fieldservice.puter.com/" title="演示地址尚未提供">试用</a>&nbsp;|&nbsp;<a href="src/field-service/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://legal.puter.com/"><img src="src/legal/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://legal.puter.com/">Legal</a></strong></td><td width="420" valign="middle">Clio, MyCase, PracticePanther</td><td width="150" valign="middle" nowrap><a href="https://legal.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/legal/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://fleet.puter.com/"><img src="src/fleet/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://fleet.puter.com/">Fleet</a></strong></td><td width="420" valign="middle">Fleetio, Samsara Fleet Maintenance, Whip Around</td><td width="150" valign="middle" nowrap><a href="https://fleet.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/fleet/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><img src="src/property-management/icon-128.png" width="48" height="48" alt="" align="center"> &nbsp; <strong><a href="src/property-management/">Property Management</a></strong></td><td width="420" valign="middle">Buildium, AppFolio, Rent Manager</td><td width="150" valign="middle" nowrap><a href="#link-status" title="演示地址尚未提供">试用</a>&nbsp;|&nbsp;<a href="src/property-management/">源码</a></td></tr>
</table>

<br>

## 开发者工具

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">可替代</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://apic.puter.com/"><img src="src/api-client/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://apic.puter.com/">API Client</a></strong></td><td width="420" valign="middle">Postman, Insomnia, Hoppscotch</td><td width="150" valign="middle" nowrap><a href="https://apic.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/api-client/">源码</a></td></tr>
</table>

<br>

## 游戏

<table width="100%">
<tr><th width="296" align="left">应用</th><th width="420" align="left">简介</th><th width="150" align="left">链接</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://chess.puter.com/"><img src="src/chess/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://chess.puter.com/">Chess</a></strong></td><td width="420" valign="middle">与电脑或好友对弈，支持棋钟和在线对战。</td><td width="150" valign="middle" nowrap><a href="https://chess.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/chess/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://backgammon.puter.com/"><img src="src/backgammon/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://backgammon.puter.com/">Backgammon</a></strong></td><td width="420" valign="middle">与电脑或好友对战，支持本地和在线游戏。</td><td width="150" valign="middle" nowrap><a href="https://backgammon.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/backgammon/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://checkers.puter.com/"><img src="src/checkers/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://checkers.puter.com/">Checkers</a></strong></td><td width="420" valign="middle">美式西洋跳棋，可与电脑或好友对战。</td><td width="150" valign="middle" nowrap><a href="https://checkers.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/checkers/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://solitaire.puter.com/"><img src="src/solitaire/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://solitaire.puter.com/">Solitaire</a></strong></td><td width="420" valign="middle">Klondike（每次翻一张或三张，可选维加斯计分）和蜘蛛纸牌，支持可选的云存档。</td><td width="150" valign="middle" nowrap><a href="https://solitaire.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/solitaire/">源码</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://sudoku.puter.com/"><img src="src/sudoku/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://sudoku.puter.com/">Sudoku</a></strong></td><td width="420" valign="middle">四种难度、每日谜题，以及讲解解题思路的提示。</td><td width="150" valign="middle" nowrap><a href="https://sudoku.puter.com/">试用</a>&nbsp;|&nbsp;<a href="src/sudoku/">源码</a></td></tr>
</table>

<br>

## 许可证

除非另有明确说明，本仓库及其所有内容、子项目、模块和组件均采用 [MIT](LICENSE) 许可证。本仓库中包含的第三方库可能受其各自许可证的约束。
