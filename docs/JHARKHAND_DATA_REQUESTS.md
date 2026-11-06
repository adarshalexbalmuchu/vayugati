# Data requests for the Jharkhand platform

Open data requests that need a person to send them. Fill the `[brackets]`, send, and file the reply under
`data/jharkhand/sources/` with its date.

## 1. Global Energy Monitor: Global Coal Mine Tracker (mine owners, operators, status, output)

Why: there is no official, open, coordinate-bearing list of Jharkhand's mines. OpenStreetMap shows 1,405 mine and
quarry shapes, of which 54 carry a name and about 50 an operator. The Tracker records each coal mine with owner,
operator, status, capacity and output, and is published with attribution.

Where: the "Download data" page of the Global Coal Mine Tracker on globalenergymonitor.org (it asks for a short form
and sends the file by email).

**Form fields**

- Name: Adarsh Alex Balmuchu
- Email: [your email]
- Organisation: [your institution or "Vayu Gati (independent project)"]
- Intended use: Non-commercial public-interest map of Jharkhand (a district and block level geospatial platform). Coal
  mine records would be matched by name and location to mapped mine areas and shown in a popup (name, owner, operator,
  status, capacity), with Global Energy Monitor credited on every popup and in the data notes.

**If there is a free-text box or an email**

> Subject: Global Coal Mine Tracker data for a Jharkhand open map
>
> Hello,
>
> I am building Vayu Gati, a non-commercial geospatial platform for Jharkhand (districts, blocks, water, forests and
> air quality), using open and official data and crediting every source. Jharkhand's mines are the largest gap: the only
> open mine shapes are volunteer-drawn, and no official list gives coordinates.
>
> Could I use the Global Coal Mine Tracker dataset for India (or Jharkhand) to show each mine's owner, operator, status
> and capacity when a user clicks a mapped mine area? I would credit Global Energy Monitor and the Tracker release
> date on every popup, keep the licence terms, and not redistribute the raw file.
>
> If the dataset has a recommended citation or terms for web maps, please tell me and I will follow them exactly.
>
> Thank you,
> Adarsh Alex Balmuchu
> [affiliation, email]

**What I will do when the file arrives**

1. Keep only Jharkhand rows; check the count against the Ministry of Coal list of mines.
2. Match each row to the nearest mapped mine area (OpenStreetMap) only where the name or location agrees closely;
   leave the rest unmatched and show "Owner: not available" rather than guess.
3. Show owner, operator, status, capacity and output with the Tracker release date and credit.

## 2. Optional: Jharkhand Department of Mines and Geology, mining lease list

Purpose: lease holder, mineral and area per lease for non-coal mines (iron ore, bauxite, limestone, mica, stone).

> Subject: Request for the list of mining leases of Jharkhand (RTI-free public data)
>
> Could the Department please share the current list of granted mining leases in Jharkhand (lessee, mineral, village,
> district, area in hectares, grant and expiry dates) and, if available, the lease boundary coordinates or shapefiles?
> The data will be shown, with the Department credited, on a non-commercial public map of Jharkhand.

If there is no reply in two weeks, the same list can be requested under the Right to Information Act, 2005 (Form: an
application to the Public Information Officer of the Department, with the fee as per Jharkhand RTI rules).

## 3. Not needed any more

- HydroSHEDS licence enquiry: India-WRIS covers the rivers, basins and dams, and its layers are in the map.
