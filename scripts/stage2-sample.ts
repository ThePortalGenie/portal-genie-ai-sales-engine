/**
 * Pinned Stage 2 sample. Recovery must use these IDs — do not re-select an easier mix.
 */
export const STAGE2_ORGANISATION_IDS = [
  "domain:rslv.co.za",
  "domain:theportalgenie.com",
  "domain:radici.co.za",
  "contact:Leads:5290417000032200001",
  "domain:insightba.co.za",
  "domain:bluelion.co.za",
  "domain:thefinanceblock.co.za",
  "domain:cloudsmartaccounting.co.za",
  "domain:atbconsulting.co.za",
  "domain:smtax.co.za",
  "domain:rta.co.za",
  "domain:naggingpanda.com",
  "domain:rae.co.za",
  "domain:taxshop.co.za",
  "domain:andersonprofessional.ca",
  "domain:humbletill.com",
  "zoho-account:5290417000030151238",
  "zoho-account:5290417000030151239",
  "zoho-account:5290417000031201369",
  "domain:lulalend.co.za",
] as const;

export const STAGE2_FAILED_ORGANISATIONS = [
  {
    organisation_id: "domain:naggingpanda.com",
    organisation_name: "Nagging Panda Pty Ltd",
    module: "Contacts",
    recordId: "5290417000030248001",
    representative_name: "Bryce Pieterse",
  },
  {
    organisation_id: "domain:taxshop.co.za",
    organisation_name: "The Tax Shop - Milnerton",
    module: "Contacts",
    recordId: "5290417000031444004",
    representative_name: "Monique De Gouveia",
  },
  {
    organisation_id: "domain:andersonprofessional.ca",
    organisation_name: "Anderson CPA Professional Corporation",
    module: "Contacts",
    recordId: "5290417000031098180",
    representative_name: "Sarah Kalina",
  },
  {
    organisation_id: "domain:humbletill.com",
    organisation_name: "Matthew Smith",
    module: "Contacts",
    recordId: "5290417000033613067",
    representative_name: "Matthew Smith",
  },
  {
    organisation_id: "zoho-account:5290417000030151238",
    organisation_name: "Acticem",
    module: "Accounts",
    recordId: "5290417000030151238",
    representative_name: "Acticem",
  },
  {
    organisation_id: "zoho-account:5290417000030151239",
    organisation_name: "Amitz",
    module: "Accounts",
    recordId: "5290417000030151239",
    representative_name: "Amitz",
  },
  {
    organisation_id: "zoho-account:5290417000031201369",
    organisation_name: "Peacock Gardens Management Ltd",
    module: "Contacts",
    recordId: "5290417000031201371",
    representative_name: "Adeel Mahmood",
  },
  {
    organisation_id: "domain:lulalend.co.za",
    organisation_name: "Lulalend",
    module: "Contacts",
    recordId: "5290417000030968487",
    representative_name: "Thabo Tshabalala",
  },
] as const;
