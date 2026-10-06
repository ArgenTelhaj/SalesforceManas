// Setup pages admins and developers open most. Paths are relative to the
// org's Lightning origin.

export const SETUP_LINKS = [
  { group: 'Users & Access', label: 'Users', path: '/lightning/setup/ManageUsers/home' },
  { group: 'Users & Access', label: 'Profiles', path: '/lightning/setup/EnhancedProfiles/home' },
  { group: 'Users & Access', label: 'Permission Sets', path: '/lightning/setup/PermSets/home' },
  { group: 'Users & Access', label: 'Permission Set Groups', path: '/lightning/setup/PermSetGroups/home' },
  { group: 'Users & Access', label: 'Roles', path: '/lightning/setup/Roles/home' },
  { group: 'Users & Access', label: 'Login History', path: '/lightning/setup/OrgLoginHistory/home' },
  { group: 'Users & Access', label: 'Sharing Settings', path: '/lightning/setup/SecuritySharing/home' },

  { group: 'Data Model', label: 'Object Manager', path: '/lightning/setup/ObjectManager/home' },
  { group: 'Data Model', label: 'Schema Builder', path: '/lightning/setup/SchemaBuilder/home' },
  { group: 'Data Model', label: 'Custom Metadata Types', path: '/lightning/setup/CustomMetadata/home' },
  { group: 'Data Model', label: 'Custom Settings', path: '/lightning/setup/CustomSettings/home' },
  { group: 'Data Model', label: 'Picklist Value Sets', path: '/lightning/setup/Picklists/home' },

  { group: 'Automation', label: 'Flows', path: '/lightning/setup/Flows/home' },
  { group: 'Automation', label: 'Approval Processes', path: '/lightning/setup/ApprovalProcesses/home' },

  { group: 'Development', label: 'Apex Classes', path: '/lightning/setup/ApexClasses/home' },
  { group: 'Development', label: 'Apex Triggers', path: '/lightning/setup/ApexTriggers/home' },
  { group: 'Development', label: 'Apex Test Execution', path: '/lightning/setup/ApexTestQueue/home' },
  { group: 'Development', label: 'Lightning Components', path: '/lightning/setup/LightningComponentBundles/home' },
  { group: 'Development', label: 'Visualforce Pages', path: '/lightning/setup/ApexPages/home' },
  { group: 'Development', label: 'Static Resources', path: '/lightning/setup/StaticResources/home' },
  { group: 'Development', label: 'Custom Labels', path: '/lightning/setup/ExternalStrings/home' },
  { group: 'Development', label: 'Developer Console', path: '/_ui/common/apex/debug/ApexCSIPage', api: true },

  { group: 'Monitoring', label: 'Debug Logs', path: '/lightning/setup/ApexDebugLogs/home' },
  { group: 'Monitoring', label: 'Apex Jobs', path: '/lightning/setup/AsyncApexJobs/home' },
  { group: 'Monitoring', label: 'Scheduled Jobs', path: '/lightning/setup/ScheduledJobs/home' },
  { group: 'Monitoring', label: 'Setup Audit Trail', path: '/lightning/setup/SecurityEvents/home' },
  { group: 'Monitoring', label: 'Storage Usage', path: '/lightning/setup/CompanyResourceDisk/home' },
  { group: 'Monitoring', label: 'Email Deliverability', path: '/lightning/setup/OrgEmailSettings/home' },

  { group: 'Deployment', label: 'Deployment Status', path: '/lightning/setup/DeployStatus/home' },
  { group: 'Deployment', label: 'Outbound Change Sets', path: '/lightning/setup/OutboundChangeSet/home' },
  { group: 'Deployment', label: 'Inbound Change Sets', path: '/lightning/setup/InboundChangeSet/home' },
  { group: 'Deployment', label: 'Installed Packages', path: '/lightning/setup/ImportedPackage/home' },
  { group: 'Deployment', label: 'Sandboxes', path: '/lightning/setup/DataManagementCreateTestInstance/home' },

  { group: 'Integration', label: 'Named Credentials', path: '/lightning/setup/NamedCredential/home' },
  { group: 'Integration', label: 'App Manager', path: '/lightning/setup/NavigationMenus/home' },
  { group: 'Integration', label: 'Connected Apps OAuth Usage', path: '/lightning/setup/ConnectedAppsUsage/home' },
  { group: 'Integration', label: 'Remote Site Settings', path: '/lightning/setup/SecurityRemoteProxy/home' },

  { group: 'Company', label: 'Company Information', path: '/lightning/setup/CompanyProfileInfo/home' },
  { group: 'Company', label: 'Setup Home', path: '/lightning/setup/SetupOneHome/home' },
];
