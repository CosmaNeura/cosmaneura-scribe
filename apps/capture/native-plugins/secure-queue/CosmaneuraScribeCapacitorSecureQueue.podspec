Pod::Spec.new do |s|
  s.name = 'CosmaneuraScribeCapacitorSecureQueue'
  s.version = '0.1.0'
  s.summary = 'Device-only encrypted queue-record persistence for Cosmaneura Capture.'
  s.license = { :type => 'Proprietary' }
  s.homepage = 'https://github.com/CosmaNeura/cosmaneura-scribe'
  s.author = { 'CosmaNeura' => 'engineering@cosmaneura.com' }
  s.source = { :git => 'https://github.com/CosmaNeura/cosmaneura-scribe.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/CosmaneuraSecureQueue/**/*.{swift}'
  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'Capacitor', '8.5.0'
end
