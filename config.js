window.BDI_FANTASY_CONFIG = {
  season: 2026,
  leagueA: {
    id: '1398722946876309504',
    label: 'League A',
    expectedManagers: [
      'Chris Marcellus','Jacob Villa','Kara Chisholm','Kraig Hamilton','Lincoln Smith',
      'Lorena Luna','Mallary Flores','Matthew Lopez','Saul Sanchez','Taylor Hadley'
    ]
  },
  leagueB: {
    id: '1398724315200913408',
    label: 'League B',
    expectedManagers: [
      'Adam Watson','Burch Weems','Evan Clark','Gabe Padukiewicz','Jamie Thayer',
      'Jeff Cohen','Jesse Sipple','John Prader',"Marc L'hoste",'Steven Fall'
    ]
  },
  // Optional: map Sleeper user IDs to the names you want shown on the BDI site.
  // Example: '123456789': 'Chris Marcellus'
  managerNameOverrides: {},
  powerRankingWeights: {
    pointsFor: 0.40,
    record: 0.30,
    recentForm: 0.20,
    allPlay: 0.10
  },
  draftGradeWeights: {
    projectionValue: 0.35,
    adpEfficiency: 0.25,
    rosterConstruction: 0.25,
    lineupStrength: 0.15
  }
};
