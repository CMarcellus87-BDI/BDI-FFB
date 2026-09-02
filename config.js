window.BDI_FANTASY_CONFIG = {
  season: 2026,

  leagueA: {
    id: '1398722946876309504',
    label: 'League A',
    // Shown only if Sleeper is unreachable, so the page is not blank.
    expectedManagers: [
      'Chris Marcellus', 'Jacob Villa', 'Kara Chisholm', 'Kraig Hamilton', 'Lincoln Smith',
      'Lorena Luna', 'Mallary Flores', 'Matthew Lopez', 'Saul Sanchez', 'Taylor Hadley'
    ]
  },

  leagueB: {
    id: '1398724315200913408',
    label: 'League B',
    expectedManagers: [
      'Adam Watson', 'Burch Weems', 'Evan Clark', 'Gabe Padukiewicz', 'Jamie Thayer',
      'Jeff Cohen', 'Jesse Sipple', 'John Prader', "Marc L'hoste", 'Steven Fall'
    ]
  },

  // Sleeper user ID to the name you want on the site.
  // Find an ID at https://api.sleeper.app/v1/league/<LEAGUE_ID>/users
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
  },

  // Change the format here rather than in the code. `advance` is how many
  // teams survive that week; the last round's 1 is the champion.
  playoffs: {
    qualifyThroughWeek: 14,
    teamsPerLeague: 4,
    rounds: [
      { week: 15, advance: 4 },
      { week: 16, advance: 2 },
      { week: 17, advance: 1 }
    ]
  }
};
