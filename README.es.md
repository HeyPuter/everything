<p align="center"><img src="assets/everything.png" width="300" alt="Everything"></p>

<h3 align="center">El software del mundo. Reconstruido y de código abierto.</h3>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>Español</strong></p>

<!-- App names, descriptions, and navigation are native text. The Everything logo, app icons, and decorative hero are images. Demo and source links use project metadata where available; missing destinations point to the link-status note. -->

<p align="center"><img src="assets/hero/variants/34-app-wall-intact.png" width="100%" alt="Everything: un muro de capturas de pantalla de aplicaciones que se extiende más allá del marco"></p>

The Everything Project es una iniciativa para reconstruir desde cero el software del mundo y publicarlo como código abierto. De Office a Slack y de Photoshop a AutoCAD, estamos creando alternativas gratuitas y de código abierto a todo el software propietario. Este es un monorrepositorio que contiene todas las aplicaciones y herramientas desarrolladas dentro del proyecto.


[Ofimática](#ofimática) · [Colaboración](#colaboración) · [Herramientas creativas](#herramientas-creativas) · [Ingeniería](#ingeniería) · [Productividad](#productividad) · [Finanzas](#finanzas) · [Negocios](#negocios) · [Herramientas para desarrolladores](#herramientas-para-desarrolladores) · [Juegos](#juegos)

<br>

## Primeros pasos

Requiere Node.js 22.12 o posterior.

```sh
git clone https://github.com/HeyPuter/everything.git
cd everything/src/[app-name]
npm install
npm run dev
```

<br>

## Ofimática

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://spreadsheet.puter.com/"><img src="src/spreadsheet/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://spreadsheet.puter.com/">Spreadsheet</a></strong></td><td width="420" valign="middle">Microsoft Excel, Google Sheets, Apple Numbers</td><td width="150" valign="middle" nowrap><a href="https://spreadsheet.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/spreadsheet/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://documents.puter.com/"><img src="src/documents/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://documents.puter.com/">Documents</a></strong></td><td width="420" valign="middle">Microsoft Word, Google Docs, Apple Pages</td><td width="150" valign="middle" nowrap><a href="https://documents.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/documents/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://presentation.puter.com/"><img src="src/presentation/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://presentation.puter.com/">Presentation</a></strong></td><td width="420" valign="middle">Microsoft PowerPoint, Google Slides, Apple Keynote</td><td width="150" valign="middle" nowrap><a href="https://presentation.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/presentation/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://whiteboard.puter.com/"><img src="src/whiteboard/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://whiteboard.puter.com/">Whiteboard</a></strong></td><td width="420" valign="middle">Miro, Microsoft Whiteboard, FigJam</td><td width="150" valign="middle" nowrap><a href="https://whiteboard.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/whiteboard/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://pdf.puter.com/"><img src="src/pdf/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://pdf.puter.com/">PDF</a></strong></td><td width="420" valign="middle">Adobe Acrobat, PDF Expert</td><td width="150" valign="middle" nowrap><a href="https://pdf.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/pdf/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://notes.puter.com/"><img src="src/notes/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://notes.puter.com/">Notes</a></strong></td><td width="420" valign="middle">Microsoft OneNote, Evernote, Apple Notes</td><td width="150" valign="middle" nowrap><a href="https://notes.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/notes/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://records.puter.com/"><img src="src/records/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://records.puter.com/">Records</a></strong></td><td width="420" valign="middle">Airtable, Microsoft Access, Baserow</td><td width="150" valign="middle" nowrap><a href="https://records.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/records/">Código</a></td></tr>
</table>

<br>

## Colaboración

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://meetings.puter.com/"><img src="src/meetings/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://meetings.puter.com/">Meetings</a></strong></td><td width="420" valign="middle">Zoom, Google Meet, Microsoft Teams</td><td width="150" valign="middle" nowrap><a href="https://meetings.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/meetings/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://teamchat.puter.com/"><img src="src/teamchat/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://teamchat.puter.com/">Teamchat</a></strong></td><td width="420" valign="middle">Slack, Microsoft Teams, Google Chat</td><td width="150" valign="middle" nowrap><a href="https://teamchat.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/teamchat/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://email.puter.com/"><img src="src/email/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://email.puter.com/">Email</a></strong></td><td width="420" valign="middle">Gmail, Microsoft Outlook, Apple Mail</td><td width="150" valign="middle" nowrap><a href="https://email.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/email/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://contacts.puter.com/"><img src="src/contacts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://contacts.puter.com/">Contacts</a></strong></td><td width="420" valign="middle">Google Contacts, Apple Contacts</td><td width="150" valign="middle" nowrap><a href="https://contacts.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/contacts/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://calendar.puter.com/"><img src="src/calendar/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://calendar.puter.com/">Calendar</a></strong></td><td width="420" valign="middle">Google Calendar, Apple Calendar, Outlook Calendar</td><td width="150" valign="middle" nowrap><a href="https://calendar.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/calendar/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://sign.puter.com/"><img src="src/signatures/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://sign.puter.com/">Signatures</a></strong></td><td width="420" valign="middle">DocuSign, Adobe Acrobat Sign, Dropbox Sign</td><td width="150" valign="middle" nowrap><a href="https://sign.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/signatures/">Código</a></td></tr>
</table>

<br>

## Herramientas creativas

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ps.puter.com/"><img src="src/photo-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ps.puter.com/">Photo Studio</a></strong></td><td width="420" valign="middle">Adobe Photoshop, Pixelmator</td><td width="150" valign="middle" nowrap><a href="https://ps.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/photo-studio/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://vs.puter.com/"><img src="src/video-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://vs.puter.com/">Video Studio</a></strong></td><td width="420" valign="middle">CapCut, Adobe Premiere Pro, Final Cut Pro, DaVinci Resolve</td><td width="150" valign="middle" nowrap><a href="https://vs.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/video-studio/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ves.puter.com/"><img src="src/vector-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ves.puter.com/">Vector Studio</a></strong></td><td width="420" valign="middle">Adobe Illustrator, CorelDRAW, Affinity Designer</td><td width="150" valign="middle" nowrap><a href="https://ves.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/vector-studio/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://as.puter.com/"><img src="src/audio-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://as.puter.com/">Audio Studio</a></strong></td><td width="420" valign="middle">Adobe Audition, Sound Forge</td><td width="150" valign="middle" nowrap><a href="https://as.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/audio-studio/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://ms.puter.com/"><img src="src/music-studio/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://ms.puter.com/">Music Studio</a></strong></td><td width="420" valign="middle">FL Studio, Ableton Live, Logic Pro</td><td width="150" valign="middle" nowrap><a href="https://ms.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/music-studio/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://3d.puter.com/"><img src="src/3d/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://3d.puter.com/">3D Studio</a></strong></td><td width="420" valign="middle">Autodesk Maya, SketchUp</td><td width="150" valign="middle" nowrap><a href="https://3d.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/3d/">Código</a></td></tr>
</table>

<br>

## Ingeniería

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://cad.puter.com/"><img src="src/cad/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://cad.puter.com/">CAD</a></strong></td><td width="420" valign="middle">AutoCAD, DraftSight, BricsCAD</td><td width="150" valign="middle" nowrap><a href="https://cad.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/cad/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://parametric.puter.com/"><img src="src/parametric/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://parametric.puter.com/">Parametric</a></strong></td><td width="420" valign="middle">SolidWorks, Autodesk Fusion, Autodesk Inventor</td><td width="150" valign="middle" nowrap><a href="https://parametric.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/parametric/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://circuits.puter.com/"><img src="src/circuits/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://circuits.puter.com/">Circuits</a></strong></td><td width="420" valign="middle">Altium Designer, Autodesk Eagle, OrCAD</td><td width="150" valign="middle" nowrap><a href="https://circuits.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/circuits/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://bd.puter.com/"><img src="src/building-design/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://bd.puter.com/">Building Design</a></strong></td><td width="420" valign="middle">Autodesk Revit, ArchiCAD, Vectorworks</td><td width="150" valign="middle" nowrap><a href="https://bd.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/building-design/">Código</a></td></tr>
</table>

<br>

## Productividad

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://tasks.puter.com/"><img src="./src/tasks/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://tasks.puter.com/">Tasks</a></strong></td><td width="420" valign="middle">Todoist, Microsoft To Do, TickTick</td><td width="150" valign="middle" nowrap><a href="https://tasks.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/tasks/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://projects.puter.com/"><img src="src/projects/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://projects.puter.com/">Projects</a></strong></td><td width="420" valign="middle">Trello, Asana, monday.com</td><td width="150" valign="middle" nowrap><a href="https://projects.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/projects/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://wiki.puter.com/"><img src="src/wiki/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://wiki.puter.com/">Wiki</a></strong></td><td width="420" valign="middle">Notion, Confluence, Coda</td><td width="150" valign="middle" nowrap><a href="https://wiki.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/wiki/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://tt.puter.com/"><img src="./src/time-tracking/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://tt.puter.com/">Time Tracking</a></strong></td><td width="420" valign="middle">Toggl Track, Harvest, Clockify</td><td width="150" valign="middle" nowrap><a href="https://tt.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/time-tracking/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://survey.puter.com/"><img src="src/survey/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://survey.puter.com/">Surveys</a></strong></td><td width="420" valign="middle">SurveyMonkey, Google Forms, Typeform</td><td width="150" valign="middle" nowrap><a href="https://survey.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/survey/">Código</a></td></tr>
</table>

<br>

## Finanzas

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://accounting.puter.com/"><img src="src/accounting/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://accounting.puter.com/">Accounting</a></strong></td><td width="420" valign="middle">QuickBooks Online, Xero, Wave Accounting</td><td width="150" valign="middle" nowrap><a href="https://accounting.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/accounting/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://invoicing.puter.com/"><img src="src/invoicing/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://invoicing.puter.com/">Invoicing</a></strong></td><td width="420" valign="middle">FreshBooks, Zoho Invoice, Wave Invoicing</td><td width="150" valign="middle" nowrap><a href="https://invoicing.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/invoicing/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://expenses.puter.com/"><img src="src/expense/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://expenses.puter.com/">Expenses</a></strong></td><td width="420" valign="middle">Expensify, SAP Concur, Zoho Expense</td><td width="150" valign="middle" nowrap><a href="#link-status" title="URL de demostración aún no disponible">Probar</a>&nbsp;|&nbsp;<a href="src/expense/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://captable.puter.com/"><img src="src/cap-table/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://captable.puter.com/">Cap Table</a></strong></td><td width="420" valign="middle">Carta, Pulley</td><td width="150" valign="middle" nowrap><a href="https://captable.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/cap-table/">Código</a></td></tr>
</table>

<br>

## Negocios

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://crm.puter.com/"><img src="src/crm/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://crm.puter.com/">CRM</a></strong></td><td width="420" valign="middle">Salesforce, HubSpot CRM, Pipedrive</td><td width="150" valign="middle" nowrap><a href="https://crm.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/crm/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://help.puter.com/"><img src="src/help-desk/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://help.puter.com/">Help Desk</a></strong></td><td width="420" valign="middle">Zendesk, Freshdesk, Intercom, Help Scout</td><td width="150" valign="middle" nowrap><a href="https://help.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/help-desk/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://contracts.puter.com/"><img src="src/contracts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://contracts.puter.com/">Contracts</a></strong></td><td width="420" valign="middle">ContractSafe, Juro</td><td width="150" valign="middle" nowrap><a href="https://contracts.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/contracts/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://pos.puter.com/"><img src="src/pos/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://pos.puter.com/">Point of Sale</a></strong></td><td width="420" valign="middle">Square POS, Shopify POS, Lightspeed</td><td width="150" valign="middle" nowrap><a href="https://pos.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/pos/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://inventory.puter.com/"><img src="src/inventory/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://inventory.puter.com/">Inventory</a></strong></td><td width="420" valign="middle">Zoho Inventory, Sortly, inFlow Inventory</td><td width="150" valign="middle" nowrap><a href="https://inventory.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/inventory/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><img src="src/assets/icon-128.png" width="48" height="48" alt="" align="center"> &nbsp; <strong><a href="../equipment/">Assets</a></strong></td><td width="420" valign="middle">Asset Panda, EZOfficeInventory</td><td width="150" valign="middle" nowrap><a href="#link-status" title="URL de demostración aún no disponible">Probar</a>&nbsp;|&nbsp;<a href="src/assets/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://hiring.puter.com/"><img src="src/hiring/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://hiring.puter.com/">Hiring</a></strong></td><td width="420" valign="middle">Greenhouse, Lever, Workable</td><td width="150" valign="middle" nowrap><a href="https://hiring.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/hiring/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://shifts.puter.com/"><img src="src/shifts/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://shifts.puter.com/">Shifts</a></strong></td><td width="420" valign="middle">Deputy, When I Work, Homebase</td><td width="150" valign="middle" nowrap><a href="https://shifts.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/shifts/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://childcare.puter.com/"><img src="src/childcare/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://childcare.puter.com/">Childcare</a></strong></td><td width="420" valign="middle">brightwheel, Procare, HiMama</td><td width="150" valign="middle" nowrap><a href="https://childcare.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/childcare/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://fieldservice.puter.com/"><img src="src/field-service/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://fieldservice.puter.com/">Field Service</a></strong></td><td width="420" valign="middle">Jobber, Housecall Pro, ServiceTitan</td><td width="150" valign="middle" nowrap><a href="https://fieldservice.puter.com/" title="URL de demostración aún no disponible">Probar</a>&nbsp;|&nbsp;<a href="src/field-service/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://legal.puter.com/"><img src="src/legal/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://legal.puter.com/">Legal</a></strong></td><td width="420" valign="middle">Clio, MyCase, PracticePanther</td><td width="150" valign="middle" nowrap><a href="https://legal.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/legal/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://fleet.puter.com/"><img src="src/fleet/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://fleet.puter.com/">Fleet</a></strong></td><td width="420" valign="middle">Fleetio, Samsara Fleet Maintenance, Whip Around</td><td width="150" valign="middle" nowrap><a href="https://fleet.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/fleet/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><img src="src/property-management/icon-128.png" width="48" height="48" alt="" align="center"> &nbsp; <strong><a href="src/property-management/">Property Management</a></strong></td><td width="420" valign="middle">Buildium, AppFolio, Rent Manager</td><td width="150" valign="middle" nowrap><a href="#link-status" title="URL de demostración aún no disponible">Probar</a>&nbsp;|&nbsp;<a href="src/property-management/">Código</a></td></tr>
</table>

<br>

## Herramientas para desarrolladores

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Alternativa a</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://apic.puter.com/"><img src="src/api-client/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://apic.puter.com/">API Client</a></strong></td><td width="420" valign="middle">Postman, Insomnia, Hoppscotch</td><td width="150" valign="middle" nowrap><a href="https://apic.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/api-client/">Código</a></td></tr>
</table>

<br>

## Juegos

<table width="100%">
<tr><th width="296" align="left">Aplicación</th><th width="420" align="left">Descripción</th><th width="150" align="left">Enlaces</th></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://chess.puter.com/"><img src="src/chess/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://chess.puter.com/">Chess</a></strong></td><td width="420" valign="middle">Juega contra la computadora o un amigo, con reloj y partidas en línea.</td><td width="150" valign="middle" nowrap><a href="https://chess.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/chess/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://backgammon.puter.com/"><img src="src/backgammon/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://backgammon.puter.com/">Backgammon</a></strong></td><td width="420" valign="middle">Juega contra la computadora o un amigo, en local o en línea.</td><td width="150" valign="middle" nowrap><a href="https://backgammon.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/backgammon/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://checkers.puter.com/"><img src="src/checkers/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://checkers.puter.com/">Checkers</a></strong></td><td width="420" valign="middle">Damas americanas contra la computadora o un amigo.</td><td width="150" valign="middle" nowrap><a href="https://checkers.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/checkers/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://solitaire.puter.com/"><img src="src/solitaire/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://solitaire.puter.com/">Solitaire</a></strong></td><td width="420" valign="middle">Klondike (robar una o tres cartas, con puntuación Vegas opcional) y Spider, con guardado en la nube opcional.</td><td width="150" valign="middle" nowrap><a href="https://solitaire.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/solitaire/">Código</a></td></tr>
<tr><td width="296" valign="middle" nowrap><a href="https://sudoku.puter.com/"><img src="src/sudoku/icon-128.png" width="48" height="48" alt="" align="center"></a> &nbsp; <strong><a href="https://sudoku.puter.com/">Sudoku</a></strong></td><td width="420" valign="middle">Cuatro niveles de dificultad, desafíos diarios y pistas que explican la lógica.</td><td width="150" valign="middle" nowrap><a href="https://sudoku.puter.com/">Probar</a>&nbsp;|&nbsp;<a href="src/sudoku/">Código</a></td></tr>
</table>

<br>

## Licencia

Este repositorio, incluidos todos sus contenidos, subproyectos, módulos y componentes, se distribuye bajo la licencia [MIT](LICENSE), salvo que se indique explícitamente lo contrario. Las bibliotecas de terceros incluidas en este repositorio pueden estar sujetas a sus propias licencias.
